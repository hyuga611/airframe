/**
 * The base class for every "no".
 *
 * Six places can decline: the lexer, the normalizer, the policy, the dry run, the
 * approval check and the apply. Making a caller catch six classes to find that
 * out is a way of guaranteeing they catch five, and the one they miss escapes as
 * an unhandled rejection at exactly the moment something was refused for a good
 * reason.
 *
 * So there is one base class and one `code` field. `instanceof Refusal` means
 * "this is a deliberate, safe outcome that you should show to a human"; anything
 * else is a defect or a driver error and should not be presented as a decision.
 */
export class Refusal extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = new.target.name;
    this.code = code;
  }
}
