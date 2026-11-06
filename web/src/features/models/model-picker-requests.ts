type SaveTicket = { context: string; generation: number; id: symbol };

/** Closing a picker invalidates its UI callbacks, not an already-issued write.
 * Keep that context locked until the write settles to prevent out-of-order saves.
 */
export function createModelPickerRequests() {
  let generation = 0;
  const saves = new Map<string, symbol>();
  return {
    invalidate() { return ++generation; },
    current(value: number) { return value === generation; },
    beginSave(context: string): SaveTicket | null {
      if (saves.has(context)) return null;
      const ticket = { context, generation, id: Symbol() };
      saves.set(context, ticket.id);
      return ticket;
    },
    canPublish(ticket: SaveTicket, context: string) {
      return ticket.context === context && ticket.generation === generation && saves.get(context) === ticket.id;
    },
    finishSave(ticket: SaveTicket) {
      if (saves.get(ticket.context) === ticket.id) saves.delete(ticket.context);
    },
    isSaving(context: string) { return saves.has(context); },
  };
}
