import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { prisma } from "../../lib/prisma";
import {
  ConflictError,
  NotFoundError,
  ValidationError,
} from "../../lib/errors";
import { logger } from "../../lib/misc";
import { maskPhone } from "../../lib/phone";
import { audit, systemActor, type Actor } from "../../services/audit";
import { notifyUsers } from "../../services/notifications";
import { publish, userRoom } from "../../services/realtime";
import { getSetting } from "../../services/settings";
import {
  a1,
  serviceAccountEmail,
  SheetsApiError,
  sheetsApi,
  startRowOf,
} from "../../services/googleSheets";
import {
  columnMapSchema,
  detectColumns,
  parseRow,
  resolveColumns,
  type ColumnMap,
  type ParsedRow,
} from "./parse";
import { DEV_NOTIFIED_MSG, reportIssue, reportIssueTx, whoLabel } from "../../services/devIssues";

/**
 * Google Sheets → leads sync (Phase 9b, D-039).
 * - Only assigned, active sheets with a Google Sheet ID are polled (`meta.syncIntervalMin`, default 3).
 * - A DB lease on the sheet row means one sync per sheet at a time across the API ("Sync now") and any number of
 *   workers; the `(sheetId, externalRowId)` unique key + createMany(skipDuplicates) guarantees no duplicate leads
 *   even if a lease expires mid-run.
 * - Only new rows become leads; existing leads are never updated, so app-side status / remarks are never overwritten.
 * - Every run writes a SheetSyncRun (sync log). Problems go to the developer only (D-045): the first failure of a
 *   streak alerts at once, again after `meta.syncFailureAlertAfter` failures in a row; skipped rows are reported too.
 *   Staff never see the reason — only that the developer has been told.
 * - Auto-detected sheets (`columnMap.auto`) re-read the header every run, so new form questions are not missed.
 */

const LEASE_MS = 2 * 60_000;
/** With an id column, re-read this many rows before the cursor so rows shifted by deletions are not missed. */
const ID_OVERLAP_ROWS = 200;
/** New leads per run; the rest come on the next run (keeps the transaction short). */
const MAX_NEW_PER_RUN = 500;

export class SyncError extends Error {}

export interface SyncResult {
  runId: string;
  status: "SUCCESS" | "FAILED";
  imported: number;
  alreadyImported: number;
  duplicatePhones: number;
  skipped: number;
  rowsRead: number;
  error: string | null;
  more: boolean;
}

/** Claim the sheet's lease. Scheduled runs also require the interval to have passed since the last attempt. */
export async function claimSheet(
  sheetId: string,
  owner: string,
  now: Date,
  intervalMin: number | null,
): Promise<boolean> {
  const where: Prisma.MetaSheetWhereInput = {
    id: sheetId,
    OR: [{ syncLeaseUntil: null }, { syncLeaseUntil: { lt: now } }],
  };
  if (intervalMin !== null)
    where.AND = [
      {
        OR: [
          { lastSyncAttemptAt: null },
          {
            lastSyncAttemptAt: {
              lte: new Date(now.getTime() - intervalMin * 60_000),
            },
          },
        ],
      },
    ];
  const r = await prisma.metaSheet.updateMany({
    where,
    data: {
      syncLeaseUntil: new Date(now.getTime() + LEASE_MS),
      syncLeaseOwner: owner,
      lastSyncAttemptAt: now,
    },
  });
  return r.count === 1;
}

async function currentMember(sheetId: string) {
  return prisma.sheetAssignment.findFirst({
    where: { sheetId, unassignedAt: null },
    select: { memberId: true },
  });
}

function errorMessage(err: unknown): string {
  if (err instanceof SheetsApiError || err instanceof SyncError)
    return err.message;
  logger.error({ err }, "sheet sync unexpected error");
  return "Sync mein ghair-mutawaqqa masla — agli sync mein dobara koshish hogi.";
}

/**
 * Re-detect an auto sheet's columns from the current header. The lead-id column never changes once chosen (it is
 * each lead's import key), so a detected id that differs from the stored one is ignored.
 */
function liveMap(stored: ColumnMap, header: string[]): ColumnMap {
  if (!stored.auto) return stored;
  const d = detectColumns(header);
  if (!d.map) return stored;
  return { ...d.map, id: stored.id ?? null };
}

const sameMap = (a: ColumnMap, b: ColumnMap) => JSON.stringify(a) === JSON.stringify(b);

/**
 * Run one sync for a sheet whose lease the caller holds. Never throws for sheet / Google problems: they are
 * recorded as a FAILED run and returned.
 */
export async function runSync(
  sheetId: string,
  opts: {
    trigger: "SCHEDULED" | "MANUAL";
    actor?: Actor;
    owner: string;
    now?: Date;
  },
): Promise<SyncResult> {
  const startedAt = opts.now ?? new Date();
  const actor = opts.actor ?? systemActor;
  const runId = randomUUID();
  const sheet = await prisma.metaSheet.findUnique({ where: { id: sheetId } });
  if (!sheet) throw new NotFoundError("Sheet");
  const base = {
    id: runId,
    sheetId,
    trigger: opts.trigger,
    actorId: actor.id,
    workerId: opts.owner,
    startedAt,
  } as const;
  let fromRow: number | null = null;
  let rowsRead = 0;

  try {
    const map = columnMapSchema.safeParse(sheet.columnMap);
    if (!sheet.googleSheetId || !sheet.tabName || !map.success)
      throw new SyncError(
        "Google Sheet ID, tab ya columns set nahi — sheet edit karein.",
      );
    const member = await currentMember(sheetId);
    if (!member)
      throw new SyncError(
        "Sheet kisi member ko assign nahi — leads import nahi hue.",
      );
    const api = sheetsApi();

    const header =
      (await api.values(sheet.googleSheetId, a1(sheet.tabName, "1:1")))
        .values[0] ?? [];
    const columns = liveMap(map.data, header);
    const { cols, missing } = resolveColumns(header, columns);
    if (!cols)
      throw new SyncError(
        `Header row mein columns nahi mile: ${missing.join(", ")}. Row 1 ke columns: ${header.filter(Boolean).join(", ") || "(khali)"}`,
      );
    const mapChanged = !sameMap(columns, map.data);

    const overlap = cols.id !== null ? ID_OVERLAP_ROWS : 0;
    const requestStart = Math.max(2, sheet.syncCursorRow + 1 - overlap);
    fromRow = requestStart;
    const data = await api.values(
      sheet.googleSheetId,
      a1(sheet.tabName, `A${requestStart}:ZZZ`),
    );
    const firstRow = startRowOf(data.range) ?? requestStart;
    rowsRead = data.values.length;
    const lastRowInSheet = rowsRead ? firstRow + rowsRead - 1 : null;

    const parsed: ParsedRow[] = data.values.map((cells, i) =>
      parseRow(cells, firstRow + i, cols),
    );
    const leadsInRange = parsed.filter(
      (p): p is Extract<ParsedRow, { kind: "lead" }> => p.kind === "lead",
    );
    // A row can repeat another lead's id (e.g. a row copied to add a test lead). When the id already belongs to a lead
    // with a different phone, the row is keyed by id + phone so it is still imported — stable on every re-read (D-047).
    // Same id and same phone is a true duplicate and stays skipped.
    const idKeyed = leadsInRange.filter((l) => l.key.startsWith("id:"));
    if (idKeyed.length) {
      const prior = await prisma.lead.findMany({
        where: { sheetId, externalRowId: { in: [...new Set(idKeyed.map((l) => l.key))] } },
        select: { externalRowId: true, phone: true },
      });
      const phoneOf = new Map(prior.map((p) => [p.externalRowId!, p.phone]));
      for (const l of idKeyed) {
        const owner = phoneOf.get(l.key);
        if (owner === undefined) phoneOf.set(l.key, l.phone);
        else if (owner !== l.phone) l.key = `${l.key}|${l.phone}`.slice(0, 191);
      }
    }
    // Two writers inserting the same keys can deadlock in InnoDB: retry; the next attempt sees the rows already there.
    let attempt = 0;
    for (;;) {
      attempt++;
      try {
        const existing = new Set(
          leadsInRange.length
            ? (
                await prisma.lead.findMany({
                  where: {
                    sheetId,
                    externalRowId: { in: leadsInRange.map((l) => l.key) },
                  },
                  select: { externalRowId: true },
                })
              ).map((l) => l.externalRowId!)
            : [],
        );

        // Walk rows in order; stop after MAX_NEW_PER_RUN new leads so the cursor never skips unprocessed rows.
        const fresh: Extract<ParsedRow, { kind: "lead" }>[] = [];
        const skippedRows: { row: number; reason: string }[] = [];
        const seenKeys = new Set<string>();
        let alreadyImported = 0;
        let cursor = sheet.syncCursorRow;
        let more = false;
        for (const p of parsed) {
          if (fresh.length >= MAX_NEW_PER_RUN) {
            more = true;
            break;
          }
          cursor = Math.max(cursor, p.row);
          if (p.kind === "blank") continue;
          // Rows before the old cursor were already handled (overlap window only re-checks ids).
          if (p.kind === "invalid") {
            if (p.row > sheet.syncCursorRow)
              skippedRows.push({ row: p.row, reason: p.reason });
            continue;
          }
          if (existing.has(p.key) || seenKeys.has(p.key)) {
            if (p.row > sheet.syncCursorRow) alreadyImported++;
            continue;
          }
          seenKeys.add(p.key);
          fresh.push(p);
        }
        // id-keyed sheets may shrink after deletions: follow the sheet's real end so new rows are re-read.
        if (!more && cols.id !== null && lastRowInSheet !== null)
          cursor = lastRowInSheet;
        if (!more && cols.id !== null && lastRowInSheet === null)
          cursor = Math.min(cursor, requestStart - 1);

        // Duplicate-phone flag (spec §8): point at the oldest lead with the same phone (any sheet), or an earlier row of this batch.
        const phones = [...new Set(fresh.map((f) => f.phone))];
        const firstByPhone = new Map<string, string>();
        if (phones.length) {
          const prior = await prisma.lead.findMany({
            where: { phone: { in: phones } },
            select: { id: true, phone: true },
            orderBy: { createdAt: "asc" },
          });
          for (const p of prior)
            if (!firstByPhone.has(p.phone)) firstByPhone.set(p.phone, p.id);
        }
        let duplicatePhones = 0;
        const rows = fresh.map((f) => {
          const id = randomUUID();
          const dup = firstByPhone.get(f.phone) ?? null;
          if (dup) duplicatePhones++;
          else firstByPhone.set(f.phone, id);
          return {
            id,
            sheetId,
            assignedMemberId: member.memberId,
            name: f.name,
            phone: f.phone,
            phoneRaw: f.phoneRaw,
            remarks: f.remarks,
            externalRowId: f.key,
            sheetRowNumber: f.row,
            duplicateOfId: dup,
          };
        });

        const imported = await prisma.$transaction(
          async (tx) => {
            const created = rows.length
              ? (await tx.lead.createMany({ data: rows, skipDuplicates: true }))
                  .count
              : 0;
            await tx.metaSheet.update({
              where: { id: sheetId },
              data: {
                syncCursorRow: cursor,
                lastSyncAt: new Date(),
                lastSyncStatus: "SUCCESS",
                lastSyncError: null,
                consecutiveFailures: 0,
                ...(mapChanged ? { columnMap: columns as Prisma.InputJsonValue } : {}),
              },
            });
            if (skippedRows.length)
              await reportIssueTx(tx, actor, {
                area: "Lead sheet",
                tried: `${opts.trigger === "MANUAL" ? "Sync now" : "Auto sync"} — ${sheet.campaign} (${sheet.title})`,
                reason: `${skippedRows.length} row import nahi hui: ${skippedRows.slice(0, 20).map((r) => `Row ${r.row}: ${r.reason}`).join(" · ")}`,
                recordType: "MetaSheet",
                recordId: sheetId,
                context: { runId, tab: sheet.tabName },
                dedupeKey: `devissue:sheetskip:${runId}`,
              });
            await tx.sheetSyncRun.create({
              data: {
                ...base,
                status: "SUCCESS",
                fromRow,
                toRow: lastRowInSheet,
                rowsRead,
                imported: created,
                alreadyImported,
                duplicatePhones,
                skipped: skippedRows.length,
                details: skippedRows.length
                  ? skippedRows.slice(0, 20)
                  : Prisma.JsonNull,
              },
            });
            if (created || opts.trigger === "MANUAL") {
              await audit(tx, actor, {
                action: "SHEET_SYNC",
                recordType: "MetaSheet",
                recordId: sheetId,
                after: {
                  runId,
                  trigger: opts.trigger,
                  imported: created,
                  duplicatePhones,
                  skipped: skippedRows.length,
                  cursor,
                },
              });
            }
            if (created) {
              const names = rows
                .slice(0, 3)
                .map((r) => r.name)
                .join(", ");
              await notifyUsers(tx, [member.memberId], {
                type: "NEW_LEADS",
                subject: `${created} naya lead${created > 1 ? "s" : ""} — ${sheet.campaign}`,
                body: `${names}${created > 3 ? ` +${created - 3}` : ""} · ${sheet.title}`,
                recordType: "MetaSheet",
                recordId: sheetId,
                priority: 1,
                dedupeKey: `sheetsync:${runId}`,
              });
              await publish(tx, [userRoom(member.memberId)], "queue:changed", {
                sheetId,
              });
            }
            return created;
          },
          { timeout: 60_000 },
        );
        await releaseLease(sheetId, opts.owner);
        return {
          runId,
          status: "SUCCESS",
          imported,
          alreadyImported,
          duplicatePhones,
          skipped: skippedRows.length,
          rowsRead,
          error: null,
          more,
        };
      } catch (err) {
        if (
          attempt < 4 &&
          err instanceof Prisma.PrismaClientKnownRequestError &&
          err.code === "P2034"
        ) {
          await new Promise((r) =>
            setTimeout(r, 40 * attempt + Math.floor(Math.random() * 40)),
          );
          continue;
        }
        throw err;
      }
    }
  } catch (err) {
    const message = errorMessage(err);
    await recordFailure(
      sheetId,
      { ...base, fromRow, rowsRead },
      message,
      actor,
      opts.trigger,
    );
    await releaseLease(sheetId, opts.owner);
    return {
      runId,
      status: "FAILED",
      imported: 0,
      alreadyImported: 0,
      duplicatePhones: 0,
      skipped: 0,
      rowsRead,
      error: message,
      more: false,
    };
  }
}

async function releaseLease(sheetId: string, owner: string) {
  await prisma.metaSheet.updateMany({
    where: { id: sheetId, syncLeaseOwner: owner },
    data: { syncLeaseUntil: null, syncLeaseOwner: null },
  });
}

async function recordFailure(
  sheetId: string,
  run: {
    id: string;
    sheetId: string;
    trigger: "SCHEDULED" | "MANUAL";
    actorId: string | null;
    workerId: string;
    startedAt: Date;
    fromRow: number | null;
    rowsRead: number;
  },
  message: string,
  actor: Actor,
  trigger: "SCHEDULED" | "MANUAL",
) {
  const alertAfter = await getSetting("meta.syncFailureAlertAfter");
  await prisma.$transaction(async (tx) => {
    const s = await tx.metaSheet.update({
      where: { id: sheetId },
      data: {
        lastSyncAt: new Date(),
        lastSyncStatus: "FAILED",
        lastSyncError: message,
        consecutiveFailures: { increment: 1 },
      },
    });
    await tx.sheetSyncRun.create({
      data: { ...run, status: "FAILED", error: message },
    });
    if (trigger === "MANUAL")
      await audit(tx, actor, {
        action: "SHEET_SYNC_FAILED",
        recordType: "MetaSheet",
        recordId: sheetId,
        after: { runId: run.id, error: message },
      });
    // Developer only (D-045): every Sync now that fails (someone is waiting on it), and for the automatic sync the
    // first failure of a streak plus a reminder when the streak reaches `meta.syncFailureAlertAfter`.
    if (trigger === "MANUAL" || s.consecutiveFailures === 1 || s.consecutiveFailures === alertAfter)
      await reportIssueTx(tx, actor, {
        area: "Lead sheet",
        tried: `${trigger === "MANUAL" ? "Sync now" : "Auto sync"} — ${s.campaign} (${s.title})`,
        reason: `${message}${s.consecutiveFailures > 1 ? ` · ${s.consecutiveFailures} dafa lagatar fail` : ""}`,
        recordType: "MetaSheet",
        recordId: sheetId,
        context: { runId: run.id, failures: s.consecutiveFailures, googleSheetId: s.googleSheetId, tab: s.tabName },
        dedupeKey: `devissue:sheetfail:${run.id}`,
      });
  });
}

/** Worker watcher: sync every due sheet. Returns the number of sheets synced this pass. */
export async function runSheetSync(now: Date, owner: string): Promise<number> {
  if ((await getSetting("meta.syncMethod")) !== "google_sheets") return 0;
  const intervalMin = await getSetting("meta.syncIntervalMin");
  const due = await prisma.metaSheet.findMany({
    where: {
      active: true,
      googleSheetId: { not: null },
      tabName: { not: null },
      assignments: { some: { unassignedAt: null } },
      OR: [
        { lastSyncAttemptAt: null },
        {
          lastSyncAttemptAt: {
            lte: new Date(now.getTime() - intervalMin * 60_000),
          },
        },
      ],
      AND: [
        { OR: [{ syncLeaseUntil: null }, { syncLeaseUntil: { lt: now } }] },
      ],
    },
    select: { id: true },
    orderBy: { lastSyncAttemptAt: "asc" },
  });
  let n = 0;
  for (const s of due) {
    if (!(await claimSheet(s.id, owner, now, intervalMin))) continue;
    const r = await runSync(s.id, { trigger: "SCHEDULED", owner, now });
    if (r.imported || r.status === "FAILED")
      logger.info({ sheetId: s.id, ...r }, "sheet sync");
    n++;
  }
  return n;
}

/**
 * First import right after a sheet is linked / assigned (D-047), so the member sees the leads at once instead of after
 * the next automatic run. Skipped quietly when the sheet is not ready (no link, no member, sync paused) or a sync is
 * already running; problems are recorded and reported like any run. Never throws.
 */
export async function syncIfReady(sheetId: string, actor: Actor): Promise<SyncResult | null> {
  try {
    if ((await getSetting("meta.syncMethod")) !== "google_sheets") return null;
    const s = await prisma.metaSheet.findUnique({ where: { id: sheetId }, select: { active: true, googleSheetId: true, tabName: true, deletedAt: true } });
    if (!s || !s.active || s.deletedAt || !s.googleSheetId || !s.tabName || !(await currentMember(sheetId))) return null;
    const owner = `link:${actor.id ?? "system"}:${randomUUID().slice(0, 8)}`;
    if (!(await claimSheet(sheetId, owner, new Date(), null))) return null;
    const r = await runSync(sheetId, { trigger: "MANUAL", actor, owner });
    return { ...r, error: r.error ? DEV_NOTIFIED_MSG : null }; // the reason went to the developer
  } catch (err) {
    logger.error({ err, sheetId }, "first sheet sync failed");
    return null;
  }
}

// ───────────── Admin (Hamza / Usama, `leads:admin`) ─────────────

/** "Sync now" — runs in the API process under the same lease as the workers. */
export async function syncNow(
  actor: Actor,
  sheetId: string,
): Promise<SyncResult> {
  const sheet = await prisma.metaSheet.findUnique({
    where: { id: sheetId },
    select: { googleSheetId: true, tabName: true, active: true },
  });
  if (!sheet) throw new NotFoundError("Sheet");
  if (!sheet.googleSheetId || !sheet.tabName)
    throw new ValidationError("Pehle Google Sheet ID aur tab set karein.");
  if (!(await currentMember(sheetId)))
    throw new ValidationError("Pehle sheet kisi member ko assign karein.");
  const owner = `api:${actor.id}:${randomUUID().slice(0, 8)}`;
  if (!(await claimSheet(sheetId, owner, new Date(), null)))
    throw new ConflictError(
      "SYNC_BUSY",
      "Is sheet ki sync abhi chal rahi hai — thori der baad dekhein.",
    );
  const r = await runSync(sheetId, { trigger: "MANUAL", actor, owner });
  // The reason went to the developer; the person who pressed Sync now only learns that it is being handled.
  return { ...r, error: r.error ? DEV_NOTIFIED_MSG : null };
}

export async function syncConfig() {
  const email = serviceAccountEmail();
  return { configured: !!email, serviceAccountEmail: email };
}

/** Per linked sheet: last sync, status, error, failure streak — for Hamza / Muaz / MD (read-only). */
export async function syncStatus() {
  const [sheets, intervalMin, method] = await Promise.all([
    prisma.metaSheet.findMany({
      where: { googleSheetId: { not: null }, active: true },
      select: { id: true, title: true, campaign: true, lastSyncAt: true, lastSyncStatus: true, lastSyncError: true, consecutiveFailures: true, assignments: { where: { unassignedAt: null }, select: { memberId: true } } },
      orderBy: [{ consecutiveFailures: 'desc' }, { title: 'asc' }],
    }),
    getSetting('meta.syncIntervalMin'),
    getSetting('meta.syncMethod'),
  ]);
  const members = await prisma.user.findMany({ where: { id: { in: sheets.flatMap((s) => s.assignments.map((a) => a.memberId)) } }, select: { id: true, displayName: true } });
  return {
    intervalMin,
    paused: method !== 'google_sheets',
    // No error text for staff (D-045) — the developer has it.
    items: sheets.map(({ assignments, lastSyncError: _e, ...s }) => ({ ...s, member: members.find((m) => m.id === assignments[0]?.memberId)?.displayName ?? null })),
  };
}

export async function syncRuns(sheetId: string) {
  const rows = await prisma.sheetSyncRun.findMany({
    where: { sheetId },
    orderBy: { startedAt: "desc" },
    take: 30,
  });
  const actors = await prisma.user.findMany({
    where: {
      id: { in: rows.map((r) => r.actorId).filter((x): x is string => !!x) },
    },
    select: { id: true, displayName: true },
  });
  return {
    // Failure reasons and skipped-row reasons go to the developer only (D-045).
    items: rows.map(({ error: _e, details: _d, workerId: _w, ...r }) => ({
      ...r,
      actor: actors.find((a) => a.id === r.actorId)?.displayName ?? null,
    })),
  };
}


const headerKey = (s: string) => s.trim().toLowerCase().replace(/[\s_-]+/g, " ");
/** Max tabs looked at when the tab is auto-detected. */
const MAX_TABS = 20;

export interface Inspection {
  title: string;
  tabs: string[];
  tabName: string;
  headers: string[];
  columnMap: ColumnMap;
  dataRows: number;
  invalidRows: number;
  idColumn: boolean;
  sample: { row: number; name: string; phone: string }[];
  /** First value of Meta's `campaign_name` / `form_id` columns, used as defaults when linking. */
  campaign: string | null;
  formId: string | null;
}

/**
 * Read a spreadsheet from its link (D-045): find the tab holding leads (the first one whose header has a name and a
 * phone column — or the given tab), detect the columns, count rows and show two masked samples.
 * Throws SyncError / SheetsApiError with the full reason (for the developer).
 */
export async function inspectSheet(
  googleSheetId: string,
  opts: { tabName?: string | null; columnMap?: ColumnMap | null } = {},
): Promise<Inspection> {
  const api = sheetsApi();
  const meta = await api.spreadsheet(googleSheetId);
  if (!meta.tabs.length) throw new SyncError(`Spreadsheet "${meta.title}" mein koi tab nahi.`);
  if (opts.tabName && !meta.tabs.includes(opts.tabName))
    throw new SyncError(`Tab "${opts.tabName}" nahi mila. Tabs: ${meta.tabs.join(", ")}`);
  const candidates = opts.tabName ? [opts.tabName] : meta.tabs.slice(0, MAX_TABS);
  const problems: string[] = [];
  let found: { tab: string; header: string[]; map: ColumnMap; cols: NonNullable<ReturnType<typeof resolveColumns>["cols"]> } | null = null;
  for (const tab of candidates) {
    const top = (await api.values(googleSheetId, a1(tab, "A1:ZZZ50"))).values;
    const header = top[0] ?? [];
    let map: ColumnMap | null = opts.columnMap ?? null;
    if (!map) {
      const d = detectColumns(header, top.slice(1));
      if (!d.map) {
        problems.push(`Tab "${tab}": ${d.problem}`);
        continue;
      }
      map = d.map;
    }
    const { cols, missing } = resolveColumns(header, map);
    if (!cols) {
      problems.push(`Tab "${tab}": header mein columns nahi mile: ${missing.join(", ")}`);
      continue;
    }
    found = { tab, header, map, cols };
    break;
  }
  if (!found) throw new SyncError(`"${meta.title}" mein leads wala tab nahi mila. ${problems.join(" · ")}`);

  const data = await api.values(googleSheetId, a1(found.tab, "A2:ZZZ"));
  const first = startRowOf(data.range) ?? 2;
  const parsed = data.values.map((c, i) => parseRow(c, first + i, found.cols));
  const leads = parsed.filter((p): p is Extract<ParsedRow, { kind: "lead" }> => p.kind === "lead");
  const firstValue = (names: string[]) => {
    const i = found.header.findIndex((h) => names.includes(headerKey(String(h ?? ""))));
    if (i < 0) return null;
    const v = data.values.map((r) => (r[i] ?? "").trim()).find(Boolean);
    return v ? v.slice(0, 190) : null;
  };
  return {
    title: meta.title,
    tabs: meta.tabs,
    tabName: found.tab,
    headers: found.header,
    columnMap: found.map,
    dataRows: leads.length,
    invalidRows: parsed.filter((p) => p.kind === "invalid").length,
    idColumn: found.cols.id !== null,
    sample: leads.slice(0, 2).map((l) => ({ row: l.row, name: l.name, phone: maskPhone(l.phone) })),
    campaign: firstValue(["campaign name", "campaign"]),
    formId: firstValue(["form id"]),
  };
}

/** The reason as the developer should read it. */
export function problemText(err: unknown): string {
  return errorMessage(err);
}

/**
 * "Check" before saving: only the link is needed — tab and columns are detected. Problems are reported to the
 * developer; the person checking gets `{ ok: false, error: <neutral message> }`.
 */
export async function testConnection(
  actor: Actor,
  input: { googleSheetId: string; link?: string; tabName?: string | null; columnMap?: ColumnMap | null },
) {
  try {
    return { ok: true as const, ...(await inspectSheet(input.googleSheetId, input)) };
  } catch (err) {
    await reportIssue(actor, {
      area: "Lead sheet",
      tried: `Sheet link check — ${input.link ?? input.googleSheetId}`,
      reason: errorMessage(err),
      context: { googleSheetId: input.googleSheetId, by: whoLabel(actor) },
    });
    return { ok: false as const, error: DEV_NOTIFIED_MSG };
  }
}
