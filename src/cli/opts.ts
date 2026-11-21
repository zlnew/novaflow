/** Options threaded to every noun command by the main dispatcher. */
export type CommandOpts = {
  /** --json: machine-readable stdout (the op's data envelope). */
  json: boolean;
  /** --watch: poll status until a terminal state (task commands). */
  watch: boolean;
  /** The common --workspace flag value (overrides the active marker). */
  workspace?: string;
};
