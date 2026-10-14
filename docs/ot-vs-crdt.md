# OT vs CRDT: why SyncDoc uses Yjs (CRDT)

## The choice

SyncDoc uses **Yjs, a CRDT** (Conflict-free Replicated Data Type), with the
Node server acting as a relay + durable log — not as an operation sequencer.

## What OT would have looked like

In Operational Transformation (Google Docs' original approach), every edit
is an operation (insert/delete at a position) that must be **transformed**
against concurrent operations to keep positions correct. That requires:

1. A single authoritative ordering of operations (usually the server).
2. A transform function for every pair of operation types (insert×insert,
   insert×delete, delete×delete) that is provably correct (satisfies TP1/TP2).
3. Clients to buffer local edits until the server acknowledges ordering.

## Why CRDT won for this project

| Concern | OT | CRDT (Yjs) |
|---|---|---|
| Offline editing | Hard: ops must be rebased against server order on reconnect | Trivial: local ops are just CRDT updates; merge on reconnect |
| Server role | Must sequence every op (bottleneck, single point of ordering) | Relay + log; no global order needed |
| Out-of-order / duplicate delivery | Dangerous without careful buffering | Safe by construction (commutative + idempotent) |
| Correctness burden | Hand-rolled transform functions, easy to get subtly wrong | Library-provided, battle-tested merge |
| Undo across peers | Natural (operation log) | Awkward (tombstones; remote undo is genuinely hard) |

The deciding factors for SyncDoc:

1. **Offline-first was a requirement.** The reconnect-with-offline-edits
   scenario is a first-class tested feature. With OT, reconnect means
   rebasing against everything that happened while you were gone — doable,
   but it's the hardest part of OT to get right. With CRDT, it's a normal
   join: exchange state vectors, swap the diffs.
2. **No central sequencer.** Socket.IO gives per-connection FIFO, but no
   global order across clients. CRDTs don't need one; OT does. Building a
   correct total-order broadcast is a distributed-systems project of its
   own.
3. **Correctness confidence.** A hand-rolled OT control algorithm is a
   classic source of subtle convergence bugs. Yjs's merge is
   property-tested by its maintainers and used in production by many
   editors. For a resume project, "chose the boring, correct primitive"
   is the defensible engineering call.

## Honest trade-offs of the CRDT choice

- **Tombstone growth.** Deleted content is retained as tombstones so
  concurrent edits can merge. Documents edited heavily over months grow
  unboundedly. Mitigation here: periodic full-state snapshots + update-log
  compaction (see `RoomManager`), which bounds the *log*, though the
  snapshot itself still carries tombstones. A production system would add
  snapshot-based state rewriting (Yjs "snapshots" API) or archival.
- **No true global undo.** Undo is per-client (ProseMirror history is
  disabled; Yjs UndoManager could be added per client, but undoing a
  *peer's* edit isn't well-defined in CRDTs).
- **Update size.** CRDT updates carry clientID/clock metadata; they're
  larger than minimal OT ops. Irrelevant at this scale.

## Where OT would be the better choice

If the product needed server-authoritative moderation of every keystroke
(e.g., exam proctoring with a canonical event log), or Google-Docs-style
cross-client undo, OT's central sequencer would be worth its complexity.
SyncDoc doesn't need either.
