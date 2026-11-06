// Only the user returned by the authenticated QR binding may drive this daemon.
export function isAccountOwner(owner: string | undefined, sender: string | undefined): boolean {
  return Boolean(owner && sender && owner === sender);
}
