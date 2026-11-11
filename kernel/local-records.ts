import type { Row } from "./evolve.ts";

export function localRecordsOf(disposition?: Row): Row[] {
  if (disposition?.localRecords) return disposition.localRecords;
  const returned = disposition?.appResult;
  const handoff = disposition?.appHandoff;
  const previous = [...(returned?.notes ?? [])];
  if (returned?.text && previous.at(-1)?.text !== returned.text)
    previous.push({ text: returned.text, at: returned.at });
  return [
    ...previous.map((note, index) => ({ ...note, id: `returned-${index}`, source: "app" })),
    ...(handoff?.notes ?? (handoff?.note ? [handoff.note] : [])).map((note: Row, index: number) => ({
      ...note,
      id: `handoff-${handoff.id}-${index}`,
      source: "app",
    })),
  ];
}
