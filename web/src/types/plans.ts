export type PlanSchedule = { zone: string; endDate?: string } & (
  | { kind: 'once'; date: string; time: string }
  | { kind: 'interval'; minutes: number }
  | { kind: 'daily'; time: string }
  | { kind: 'weekly'; days: number[]; time: string }
  | { kind: 'monthly'; day: number | 'last'; time: string }
);

export type PlanInput = { id?: string; workspace: string; name: string; prompt: string; schedule: PlanSchedule };
export type StudioPlan = PlanInput & {
  id: string; status: 'active' | 'paused' | 'completed'; nextAt: number | null;
  activeRunId: string | null; runStatus: 'queued' | 'running' | null;
};
export type PlanAction = 'run' | 'pause' | 'resume' | 'delete' | 'stop';
export type PlanRun = {
  id: string; planId: string | null; name: string; workspace: string; trigger: 'manual' | 'scheduled';
  dueAt: number; queuedAt: number; startedAt: number | null; finishedAt: number | null;
  status: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled'; detail: string; sessionId: string | null;
};
export type PlanCursor = { at: number; id: string };
export type PlanHistory = { items: PlanRun[]; cursor: PlanCursor | null };
export type PlanDayEntry = Pick<PlanRun, 'planId' | 'name' | 'workspace'> & {
  at: number; status: PlanRun['status'] | 'scheduled'; runs: number;
};
export type PlanWeek = { plans: StudioPlan[]; days: PlanDayEntry[][] };
