export type TaskBoardStatus = 'todo' | 'in_progress' | 'blocked' | 'done';
export type TaskBoardPriority = 'low' | 'normal' | 'high' | 'urgent';
export type TaskBoardScheduleField = 'plannedStartAt' | 'plannedEndAt' | 'actualStartAt' | 'actualEndAt';
export type TaskBoardDateField = 'createdAt' | 'updatedAt' | TaskBoardScheduleField;

export type TaskBoardFields = Record<TaskBoardScheduleField, string | null> & {
  title: string;
  details: string;
  status: TaskBoardStatus;
  priority: TaskBoardPriority;
};

export type TaskBoardTask = TaskBoardFields & {
  id: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
};

export type TaskBoardQuery = {
  status?: TaskBoardStatus;
  dateField?: TaskBoardDateField;
  from?: string;
  to?: string;
  limit?: number;
  offset?: number;
};

export type TaskBoardSnapshot = {
  tasks: TaskBoardTask[];
  total: number;
  nextOffset: number | null;
};

export type TaskBoardMutation =
  | { action: 'create'; id: string; fields: TaskBoardFields }
  | { action: 'update'; id: string; revision: number; fields: Partial<TaskBoardFields> };
