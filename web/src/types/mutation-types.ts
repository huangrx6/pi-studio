/** A completed write and the following runtime/read phase are separate facts. */
export type MutationProjection<T> =
  | { status: 'ready'; value: T }
  | { status: 'error'; message: string };

export type CommittedProjection<T> = {
  committed: true;
  projection: MutationProjection<T>;
};
