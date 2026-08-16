/**
 * What a runner returns.
 *
 * The distinction that matters: `text` present means the model answered and the
 * attempt is SCOREABLE, whatever the answer was. `unscored` means the harness
 * could not obtain an answer at all (crash, timeout, transport error), and the
 * attempt is excluded from the denominator rather than counted as a failure.
 * Recording a harness problem as a model failure is how a benchmark ends up
 * measuring its own plumbing.
 */
export interface RunnerResult {
  /** The model's completion, or undefined if we never got one. */
  text?: string;
  /** Set when the attempt could not be scored. Mutually exclusive with text. */
  unscored?: string;
  /**
   * The model exhausted its tool budget without producing a final answer.
   * Scored as a failure (class `no-answer`), never as unscored.
   */
  noAnswer?: boolean;
  /** Tool names called, in order, including repeats. */
  toolCalls: string[];
  /** Assistant turns taken before the final answer. */
  turns: number;
  /** Wall clock for the attempt. */
  ms: number;
  /** USD, where the runner can report it. */
  costUsd?: number;
  /**
   * The model the provider says actually served the request. Recorded rather
   * than assumed: `--model haiku` on this CLI resolves to a Sonnet model, so a
   * run labelled by the requested alias would misreport its own subject.
   */
  servedModel?: string;
}

export interface RunnerRequest {
  system: string;
  user: string;
  /** Arm C and D get the live MCP server; A and B must get no tools at all. */
  withMcp: boolean;
}
