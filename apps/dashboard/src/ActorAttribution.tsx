import { identifier, object, textValue } from "./operator";
export interface ActorIdentity {
  id: string;
  type: "operator" | "installation_recovery" | "installation_configuration";
  name: string;
}
export function validActorIdentity(value: unknown): value is ActorIdentity {
  return (
    object(value) &&
    identifier(value.id) &&
    textValue(value.name, 128) &&
    (value.type === "operator" ||
      value.type === "installation_recovery" ||
      value.type === "installation_configuration")
  );
}
export function validOptionalActor(value: unknown): boolean {
  return value == null || validActorIdentity(value);
}
/** Attribution was captured with the resource; never resolve a mutable operator name here. */
export function ActorAttribution({
  value,
  legacy,
}: {
  value: unknown;
  legacy?: string | null;
}) {
  if (value == null)
    return (
      <>
        {legacy === "administrator" ? (
          "Shared administrator (legacy)"
        ) : legacy ? (
          <span className="identifier" translate="no">
            {legacy} · name not recorded
          </span>
        ) : (
          "Actor not recorded"
        )}
      </>
    );
  if (!validActorIdentity(value)) return <>Attribution could not be read</>;
  if (value.type === "installation_configuration")
    return <>Host configuration</>;
  return (
    <>
      {value.type === "installation_recovery" ? "Host recovery" : value.name}{" "}
      <span className="identifier" translate="no">
        ({value.id})
      </span>
    </>
  );
}
