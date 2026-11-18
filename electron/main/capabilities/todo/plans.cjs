const { createLongTaskContract } = require('../long-task/index.cjs');

const TODO_DOC_KIND = 'studio.todo';
const TODO_SCHEMA_VERSION = 2;
const contracts = new WeakMap();
const checkpointWhen = (_value, _ops, info) => info.deltasSinceBase >= 64;

function emptyIndex() {
  return { count: 0, nextId: 1 };
}

// v1 stored a single conversation-wide list. Its original turn and goal are unknown.
function migrateIndex(value, version) {
  if (version !== 1) throw new Error('无法升级此版本的任务清单');
  const tasks = value.tasks || [];
  const nextId = Math.max(1, value.nextId || 1, ...tasks.map(task => task.id + 1));
  const index = { count: tasks.length ? 1 : 0, nextId };
  if (tasks.length) index.legacy = { id: 1, scope: 'legacy', title: '早期会话任务', tasks };
  if (value.lastMutationTaskId) index.legacyMutation = { taskId: value.lastMutationTaskId, planId: index.count };
  return index;
}

function todoContracts(durable) {
  if (!contracts.has(durable)) {
    const shared = { scope: 'conversation', history: 'rewindable', fork: 'asOf', checkpointWhen };
    contracts.set(durable, {
      index: durable.defineDoc({ ...shared, kind: TODO_DOC_KIND, version: TODO_SCHEMA_VERSION, initial: emptyIndex, migrate: migrateIndex }),
      plans: durable.defineDocFamily({ ...shared, family: true, kind: 'studio.todo-plan', version: 1, initial: seed => seed }),
      receipt: durable.defineDoc({ kind: 'studio.todo-mutation', scope: 'task', version: 1, initial: () => ({}), checkpointWhen }),
      goal: createLongTaskContract(durable).LongTask,
      live: durable.LiveDoc,
    });
  }
  return contracts.get(durable);
}

function runTurnId(live) {
  const run = live?.run;
  if (!run || run.afterRun) return undefined;
  if (run.inputs?.[0]) return String(run.inputs[0]);
  return run.first ? `entry-${run.first}` : undefined;
}

function goalOwner(goal) {
  return goal?.enabled && goal.goalId && ['active', 'paused', 'blocked'].includes(goal.status)
    ? goal.goalId : undefined;
}

function matchingPlan(index, scope, owner) {
  const ref = index?.[scope];
  return owner && ref?.owner === owner ? ref.id : undefined;
}

function planDetails(plan, conversationId, nextId) {
  const details = { schemaVersion: TODO_SCHEMA_VERSION, nextId, tasks: [] };
  if (!plan) return details;
  return {
    ...details,
    planId: plan.id,
    conversationId: String(conversationId),
    scope: plan.scope,
    title: plan.title,
    ...(plan.turnId ? { turnId: plan.turnId } : {}),
    ...(plan.goalId ? { goalId: plan.goalId } : {}),
    ...(plan.lastTurnId ? { lastTurnId: plan.lastTurnId } : {}),
    ...(plan.createdAt ? { createdAt: plan.createdAt, updatedAt: plan.updatedAt } : {}),
    tasks: plan.tasks.map(task => ({ ...task, ...(task.blockedBy ? { blockedBy: [...task.blockedBy] } : {}) })),
  };
}

async function readTodoDetails(durable, reader, conversationId, context) {
  const tokens = todoContracts(durable);
  const [index, live, goal] = await Promise.all([tokens.index, tokens.live, tokens.goal]
    .map(token => reader.snapshot(token, conversationId, context)));
  if (!index) return undefined;
  const turnId = runTurnId(live);
  const turnPlan = matchingPlan(index, 'turn', turnId);
  const goalPlan = matchingPlan(index, 'goal', goalOwner(goal));
  const selectedGoal = index.selection?.turnId === turnId && index.selection?.scope === 'goal';
  const id = !turnId || selectedGoal ? goalPlan : turnPlan;
  if (!id) return undefined;
  const plan = await reader.snapshot(tokens.plans, conversationId, String(id), context);
  return plan && planDetails(plan, conversationId, index.nextId);
}

// A cursor is the next plan number, inclusive. New plans cannot shift older pages.
async function readTodoHistory(durable, reader, conversationId, options, context) {
  const { cursor, limit = 10 } = options;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 25) throw new Error('每页可读取 1 至 25 份任务清单');
  if (cursor !== undefined && (!Number.isSafeInteger(cursor) || cursor < 1)) throw new Error('任务历史游标无效');
  const tokens = todoContracts(durable);
  const [index, live, goal] = await Promise.all([tokens.index, tokens.live, tokens.goal]
    .map(token => reader.snapshot(token, conversationId, context)));
  const currentTurn = matchingPlan(index, 'turn', runTurnId(live));
  const currentGoal = matchingPlan(index, 'goal', goalOwner(goal));
  const start = Math.min(cursor ?? Infinity, index?.count ?? 0);
  const end = Math.max(0, start - limit);
  const items = [];
  for (let id = start; id > end; id--) {
    const plan = id === 1 && index.legacy ? index.legacy
      : await reader.snapshot(tokens.plans, conversationId, String(id), context);
    if (!plan) throw new Error('任务历史暂时无法读取，请重试');
    // Selection chooses one sidebar list; both owners can still be open in history.
    const currentOwner = plan.scope === 'goal' ? currentGoal : currentTurn;
    const lifecycle = plan.scope === 'legacy' ? 'unknown' : id === currentOwner ? 'open' : 'ended';
    items.push({ ...planDetails(plan, conversationId, index.nextId), lifecycle });
  }
  return { items, nextCursor: end || null };
}

async function executePlanAction(durable, api, args, applyMutation, context) {
  const tokens = todoContracts(durable);
  const conversationId = api.conversationId;
  const readOnly = args.action === 'list' || args.action === 'get';
  return api.commit(async tx => {
    const index = await tx.doc(tokens.index, conversationId);
    const receipt = readOnly ? undefined : await tx.doc(tokens.receipt, api.taskId);
    if (receipt && index.legacyMutation?.taskId === api.taskId) {
      const previous = index.legacy ?? (index.legacyMutation.planId && await tx.doc(tokens.plans, conversationId, '1', {}));
      return { details: planDetails(previous, conversationId, index.nextId), message: '这次任务计划变更已经记录。' };
    }
    if (receipt?.message) {
      const previous = receipt.planId && await tx.doc(tokens.plans, conversationId, String(receipt.planId), {});
      return { details: planDetails(previous, conversationId, index.nextId), message: receipt.message };
    }
    const live = await tx.doc(tokens.live, conversationId);
    const turnId = runTurnId(live);
    if (!turnId) throw new Error('当前没有执行中的任务轮次');
    const goal = await tx.doc(tokens.goal, conversationId);
    const goalId = goalOwner(goal);
    const selection = index.selection?.turnId === turnId ? index.selection : undefined;
    // Studio stamps only its own explicit Goal start/resume submissions.
    const firstEntry = args.scope !== 'turn' && goalId && live.run.first
      ? await tx.entry(live.run.first) : undefined;
    const resumedGoal = firstEntry?.data?.studioGoalId;
    const scope = args.scope ?? selection?.scope ?? (resumedGoal ? 'goal' : 'turn');
    const expectedGoal = resumedGoal || selection?.goalId;
    if (scope === 'goal' && expectedGoal && expectedGoal !== goalId) throw new Error('该轮所属目标已经更换');
    if (!['turn', 'goal'].includes(scope)) throw new Error('任务清单范围无效');
    if (scope === 'goal' && (!goalId || (!readOnly && goal.status !== 'active'))) throw new Error('当前没有执行中的目标');
    const owner = scope === 'goal' ? goalId : turnId;
    let planId = matchingPlan(index, scope, owner);
    let plan = planId && await tx.doc(tokens.plans, conversationId, String(planId), {});
    const now = api.now();
    const result = applyMutation({ tasks: plan?.tasks || [], nextId: index.nextId }, args, now);
    if (!readOnly) {
      if (index.legacy) {
        await tx.doc(tokens.plans, conversationId, '1', planDetailsSeed(index.legacy));
        delete index.legacy;
      }
      if (args.action === 'clear') {
        // Detach the owner; history keeps the last recorded state of every item.
        if (planId) delete index[scope];
        plan = undefined;
        planId = undefined;
      } else if (result.changed) {
        if (!plan) {
          planId = index.count + 1;
          plan = await tx.doc(tokens.plans, conversationId, String(planId), {
            id: planId, scope, turnId, createdAt: now, ...(scope === 'goal' ? { goalId } : {}),
            title: scope === 'goal' ? goal.goal : result.state.tasks[0].subject, tasks: [],
          });
          index.count = planId;
          index[scope] = { owner, id: planId };
        }
        if (scope === 'goal') plan.title = goal.goal;
        plan.tasks = result.state.tasks;
        plan.lastTurnId = turnId;
        plan.updatedAt = now;
        index.nextId = result.state.nextId;
      }
      receipt.message = result.message;
      if (planId) receipt.planId = planId;
    }
    index.selection = { scope, turnId, ...(scope === 'goal' ? { goalId } : {}) };
    return { details: planDetails(plan, conversationId, index.nextId), message: result.message };
  }, context);
}

// tx.doc seeds are plain JSON, detached from the source document's mutable draft.
function planDetailsSeed(plan) {
  return { id: plan.id, scope: plan.scope, title: plan.title, tasks: plan.tasks.map(task => ({
    ...task, ...(task.blockedBy ? { blockedBy: [...task.blockedBy] } : {}),
  })) };
}

module.exports = { TODO_DOC_KIND, TODO_SCHEMA_VERSION, executePlanAction, readTodoDetails, readTodoHistory };
