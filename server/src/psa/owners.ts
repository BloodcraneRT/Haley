import type { Store } from "../store.js";
import type { Technician } from "../types.js";
import type { PsaOwner } from "./types.js";

/**
 * The directory technician a PSA owner is: by the PSA id saved for this connection, then by email, then by name
 * (ignoring case). A match by email or name saves the PSA id, so later matches don't depend on names.
 */
export function matchOwner(store: Store, connectionId: string, owner: PsaOwner | null | undefined): Technician | null {
  if (!owner) return null;
  const technicians = store.listTechnicians({ activeOnly: true });
  const byRef = technicians.find((t) => t.psa_refs[connectionId] === owner.id);
  if (byRef) return byRef;
  const email = owner.email?.toLowerCase();
  const name = owner.name.trim().toLowerCase();
  const found = (email && technicians.find((t) => t.email?.toLowerCase() === email)) || (name && technicians.find((t) => t.name.toLowerCase() === name)) || null;
  if (found && !found.psa_refs[connectionId]) store.updateTechnician(found.id, { psaRefs: { ...found.psa_refs, [connectionId]: owner.id } });
  return found;
}
