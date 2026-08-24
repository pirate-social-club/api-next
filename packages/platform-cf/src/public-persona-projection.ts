import type { PublicPersonaV1 } from "@pirate/contracts";

const validId = (value: string): boolean =>
  value.length > 0 && value.length <= 128 && value === value.trim();

export function publicPersonaFromSql(value: unknown): PublicPersonaV1 | null | undefined {
  if (value === null) return null;
  const parsed =
    typeof value === "string"
      ? (() => {
          try {
            return JSON.parse(value) as unknown;
          } catch {
            return undefined;
          }
        })()
      : value;
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
  const persona = parsed as Record<string, unknown>;
  const nullable = (field: string): string | null | undefined => {
    const candidate = persona[field];
    return candidate === null ? null : typeof candidate === "string" ? candidate : undefined;
  };
  const personaId = persona.persona_id;
  const displayName = nullable("display_name");
  const avatarRef = nullable("avatar_ref");
  const primaryPublicHandle = nullable("primary_public_handle");
  if (
    persona.object !== "persona" ||
    typeof personaId !== "string" ||
    !validId(personaId) ||
    displayName === undefined ||
    avatarRef === undefined ||
    primaryPublicHandle === undefined
  ) {
    return undefined;
  }
  return {
    persona_id: personaId,
    object: "persona",
    display_name: displayName,
    avatar_ref: avatarRef,
    primary_public_handle: primaryPublicHandle,
  };
}
