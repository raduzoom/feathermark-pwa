/** A caller's own mistake (wrong length, wrong parameters): rejected before any crypto runs (crypto.md, "Errors"). */
export class InvalidArgument extends Error {
  override name = 'InvalidArgument'
}
