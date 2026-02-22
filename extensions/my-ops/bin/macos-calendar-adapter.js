#!/usr/bin/env node

import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function readString(value) {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed || undefined;
}

function readBoolean(value, fallback = false) {
  return typeof value === "boolean" ? value : fallback;
}

function readPositiveInt(value, fallback) {
  if (typeof value === "number" && Number.isFinite(value)) {
    const n = Math.floor(value);
    if (n > 0) return n;
  }
  if (typeof value === "string") {
    const parsed = Number.parseInt(value.trim(), 10);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return fallback;
}

function readStringArray(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .filter((entry) => typeof entry === "string")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

async function readJsonStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  const text = Buffer.concat(chunks).toString("utf8").trim();
  if (!text) {
    throw new Error("empty stdin; expected JSON envelope");
  }
  return JSON.parse(text);
}

function writeJson(payload) {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

async function runCommand(argv, options = {}) {
  const timeoutMs = readPositiveInt(options.timeoutMs, 30_000);
  return await new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    const hasInput = typeof options.input === "string";
    const child = spawn(argv[0], argv.slice(1), {
      stdio: [hasInput ? "pipe" : "ignore", "pipe", "pipe"],
      env: options.env ? { ...process.env, ...options.env } : process.env,
      cwd: options.cwd,
    });
    const timer = setTimeout(() => {
      if (!settled) {
        child.kill("SIGKILL");
      }
    }, timeoutMs);

    if (hasInput && child.stdin) {
      child.stdin.write(options.input);
      child.stdin.end();
    }

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        code,
        signal,
        killed: child.killed,
        stdout,
        stderr,
        timeoutMs,
      });
    });
  });
}

function resolveAdapterSettings(envelope) {
  const payload = isRecord(envelope?.payload) ? envelope.payload : {};
  const envOsa = readString(process.env.MYOPS_CALENDAR_OSASCRIPT_BIN) ?? "/usr/bin/osascript";
  const envTimeoutMs = readPositiveInt(process.env.MYOPS_CALENDAR_TIMEOUT_MS, 20_000);
  const envDefaultCalendar = readString(process.env.MYOPS_CALENDAR_DEFAULT_CALENDAR);

  return {
    osascriptBin: readString(payload.osascriptBin) ?? envOsa,
    timeoutMs: readPositiveInt(payload.timeoutMs, envTimeoutMs),
    defaultCalendar: readString(payload.defaultCalendar) ?? envDefaultCalendar,
    payload,
  };
}

function parseJsonOrUndefined(text) {
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  try {
    return JSON.parse(trimmed);
  } catch {
    return undefined;
  }
}

function jxaScriptSource() {
  return String.raw`
ObjC.import("Foundation");
ObjC.import("stdlib");

function readEnv(name) {
  try {
    var env = $.NSProcessInfo.processInfo.environment;
    var v = env.objectForKey($(name));
    return v ? ObjC.unwrap(v) : null;
  } catch (e) {
    return null;
  }
}

function readTextFile(p) {
  var nsPath = $(p).stringByStandardizingPath;
  var data = $.NSData.dataWithContentsOfFile(nsPath);
  if (!data) throw new Error("cannot read request file: " + p);
  var str = $.NSString.alloc.initWithDataEncoding(data, $.NSUTF8StringEncoding);
  return ObjC.unwrap(str);
}

function safeCall(obj, methodName, fallback) {
  try {
    if (!obj) return fallback;
    var fn = obj[methodName];
    if (typeof fn === "function") return obj[methodName]();
    return typeof fn === "undefined" ? fallback : fn;
  } catch (e) {
    return fallback;
  }
}

function realizeCollection(coll) {
  if (coll === null || typeof coll === "undefined") return [];
  var target = coll;
  if (typeof target === "function") {
    try {
      target = target();
    } catch (e) {
      // keep original
    }
  }
  if (Array.isArray(target)) return target;
  if (typeof target.length === "number") {
    var out = [];
    for (var i = 0; i < target.length; i++) out.push(target[i]);
    return out;
  }
  return [target];
}

function cleanString(v) {
  if (v === null || typeof v === "undefined") return null;
  var s = String(v);
  return s;
}

function toIso(v) {
  if (!v) return null;
  try {
    var d = new Date(v);
    if (!Number.isFinite(d.getTime())) return null;
    return d.toISOString();
  } catch (e) {
    return null;
  }
}

function parseDateInput(value, fieldName) {
  if (value instanceof Date) {
    if (!Number.isFinite(value.getTime())) throw new Error("invalid date for " + fieldName);
    return value;
  }
  if (typeof value === "number") {
    var dn = new Date(value);
    if (!Number.isFinite(dn.getTime())) throw new Error("invalid timestamp for " + fieldName);
    return dn;
  }
  if (typeof value !== "string") throw new Error(fieldName + " must be a date string");
  var s = value.trim();
  if (!s) throw new Error(fieldName + " is empty");
  var m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) {
    var y = Number(m[1]);
    var mo = Number(m[2]);
    var da = Number(m[3]);
    var dd = new Date(y, mo - 1, da, 0, 0, 0, 0);
    if (!Number.isFinite(dd.getTime())) throw new Error("invalid date for " + fieldName);
    return dd;
  }
  var d = new Date(s);
  if (!Number.isFinite(d.getTime())) throw new Error("invalid date for " + fieldName + ": " + s);
  return d;
}

function normalizeDateRange(payload) {
  var now = new Date();
  var start = payload.start ? parseDateInput(payload.start, "payload.start") : new Date(now.getTime());
  var end = payload.end ? parseDateInput(payload.end, "payload.end") : new Date(start.getTime() + 7 * 24 * 60 * 60 * 1000);
  if (!(end > start)) throw new Error("payload.end must be later than payload.start");
  return { start: start, end: end };
}

function clampPositiveInt(v, fallback, max) {
  var n = fallback;
  if (typeof v === "number" && isFinite(v)) n = Math.floor(v);
  else if (typeof v === "string" && v.trim()) n = parseInt(v.trim(), 10);
  if (!isFinite(n) || n <= 0) n = fallback;
  if (typeof max === "number" && isFinite(max) && n > max) n = max;
  return n;
}

function hasOwn(obj, key) {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

function eventToJson(ev, calendarName) {
  var uid = safeCall(ev, "uid", null) || safeCall(ev, "id", null);
  return {
    id: uid ? String(uid) : null,
    uid: uid ? String(uid) : null,
    calendar: calendarName || (safeCall(safeCall(ev, "calendar", null), "name", null) || null),
    title: cleanString(safeCall(ev, "summary", null)),
    summary: cleanString(safeCall(ev, "summary", null)),
    start: toIso(safeCall(ev, "startDate", null)),
    end: toIso(safeCall(ev, "endDate", null)),
    allDay: safeCall(ev, "alldayEvent", false) === true,
    location: cleanString(safeCall(ev, "location", null)),
    notes: cleanString(safeCall(ev, "description", null)),
    url: cleanString(safeCall(ev, "url", null)),
    status: cleanString(safeCall(ev, "status", null)),
    sequence: safeCall(ev, "sequence", null),
    modifiedAt: toIso(safeCall(ev, "stampDate", null)),
  };
}

function calendarToJson(cal) {
  return {
    name: cleanString(safeCall(cal, "name", null)),
    calendarIdentifier: cleanString(safeCall(cal, "calendarIdentifier", null)),
    writable: safeCall(cal, "writable", false) === true,
    description: cleanString(safeCall(cal, "description", null)),
  };
}

function allCalendars(Calendar) {
  return realizeCollection(Calendar.calendars());
}

function selectCalendars(Calendar, cfg, payload) {
  var names = [];
  if (typeof payload.calendar === "string" && payload.calendar.trim()) names.push(payload.calendar.trim());
  if (Array.isArray(payload.calendars)) {
    for (var i = 0; i < payload.calendars.length; i++) {
      var n = payload.calendars[i];
      if (typeof n === "string" && n.trim()) names.push(n.trim());
    }
  }
  var uniqueNames = [];
  for (var j = 0; j < names.length; j++) {
    if (uniqueNames.indexOf(names[j]) < 0) uniqueNames.push(names[j]);
  }
  if (uniqueNames.length === 0) {
    return allCalendars(Calendar);
  }
  var selected = [];
  for (var k = 0; k < uniqueNames.length; k++) {
    var found = realizeCollection(Calendar.calendars.whose({ name: uniqueNames[k] }));
    for (var x = 0; x < found.length; x++) selected.push(found[x]);
  }
  return selected;
}

function pickTargetCalendar(Calendar, cfg, payload) {
  var requested = typeof payload.calendar === "string" && payload.calendar.trim() ? payload.calendar.trim() : null;
  if (!requested && cfg && typeof cfg.defaultCalendar === "string" && cfg.defaultCalendar.trim()) {
    requested = cfg.defaultCalendar.trim();
  }
  if (requested) {
    var byName = realizeCollection(Calendar.calendars.whose({ name: requested }));
    if (byName[0]) return byName[0];
    throw new Error("calendar not found: " + requested);
  }
  var all = allCalendars(Calendar);
  for (var i = 0; i < all.length; i++) {
    if (safeCall(all[i], "writable", false) === true) return all[i];
  }
  if (all[0]) return all[0];
  throw new Error("no calendars available");
}

function listCalendars(Calendar) {
  var cals = allCalendars(Calendar).map(calendarToJson).sort(function(a, b) {
    return String(a.name || "").localeCompare(String(b.name || ""));
  });
  return { calendars: cals, count: cals.length };
}

function listEvents(Calendar, cfg, payload, action) {
  var range = normalizeDateRange(payload || {});
  var limit = clampPositiveInt(payload.limit, 50, 500);
  var includeNotes = payload.includeNotes === true;
  var query = typeof payload.query === "string" ? payload.query.trim().toLowerCase() : "";
  var selected = selectCalendars(Calendar, cfg, payload || {});
  var items = [];

  for (var i = 0; i < selected.length; i++) {
    var cal = selected[i];
    var calName = cleanString(safeCall(cal, "name", null));
    var spec;
    try {
      spec = cal.events.whose({
        startDate: { _lessThan: range.end },
        endDate: { _greaterThan: range.start },
      });
    } catch (e) {
      spec = cal.events();
    }
    var events = realizeCollection(spec);
    for (var j = 0; j < events.length; j++) {
      var row = eventToJson(events[j], calName);
      if (!row.id) continue;
      var startMs = row.start ? new Date(row.start).getTime() : Number.NaN;
      var endMs = row.end ? new Date(row.end).getTime() : Number.NaN;
      if (!(Number.isFinite(startMs) && Number.isFinite(endMs))) continue;
      if (!(startMs < range.end.getTime() && endMs > range.start.getTime())) continue;
      if (query) {
        var hay = [row.title, row.location, includeNotes ? row.notes : null]
          .filter(Boolean)
          .join("\n")
          .toLowerCase();
        if (hay.indexOf(query) < 0) continue;
      }
      if (!includeNotes) delete row.notes;
      items.push(row);
    }
  }

  items.sort(function(a, b) {
    var as = a.start ? new Date(a.start).getTime() : 0;
    var bs = b.start ? new Date(b.start).getTime() : 0;
    if (as !== bs) return as - bs;
    return String(a.title || "").localeCompare(String(b.title || ""));
  });

  if (items.length > limit) items = items.slice(0, limit);
  return {
    items: items,
    count: items.length,
    range: { start: range.start.toISOString(), end: range.end.toISOString() },
    action: action,
  };
}

function findEvent(Calendar, cfg, payload) {
  var id = payload.id || payload.uid || payload.eventId;
  if (typeof id !== "string" || !id.trim()) throw new Error("payload.id (or uid/eventId) required");
  var targetId = id.trim();
  var selected = selectCalendars(Calendar, cfg, payload || {});
  for (var i = 0; i < selected.length; i++) {
    var cal = selected[i];
    var calName = cleanString(safeCall(cal, "name", null));
    try {
      var byId = cal.events.byId(targetId);
      // Touch a property to ensure the specifier resolves.
      safeCall(byId, "summary", null);
      var row = eventToJson(byId, calName);
      if (row.id) return { event: byId, json: row, calendar: cal };
    } catch (e) {
      // fallback search
    }
    var evs = realizeCollection(cal.events());
    for (var j = 0; j < evs.length; j++) {
      var uid = cleanString(safeCall(evs[j], "uid", null) || safeCall(evs[j], "id", null));
      if (uid && uid === targetId) {
        return { event: evs[j], json: eventToJson(evs[j], calName), calendar: cal };
      }
    }
  }
  return null;
}

function ensureEventTimes(payload) {
  var allDay = payload.allDay === true || payload.allday === true || payload.alldayEvent === true;
  var start = parseDateInput(payload.start, "payload.start");
  var end = payload.end ? parseDateInput(payload.end, "payload.end") : null;
  if (!end) {
    end = new Date(start.getTime());
    end.setHours(end.getHours() + (allDay ? 24 : 1));
  }
  if (!(end > start)) throw new Error("payload.end must be later than payload.start");
  return { start: start, end: end, allDay: allDay };
}

function createEvent(Calendar, cfg, payload) {
  var title = typeof payload.title === "string" && payload.title.trim()
    ? payload.title.trim()
    : typeof payload.summary === "string" && payload.summary.trim()
      ? payload.summary.trim()
      : null;
  if (!title) throw new Error("payload.title (or summary) required");
  var targetCalendar = pickTargetCalendar(Calendar, cfg, payload || {});
  var times = ensureEventTimes(payload || {});
  var props = {
    summary: title,
    startDate: times.start,
    endDate: times.end,
  };
  if (typeof payload.location === "string") props.location = payload.location;
  if (typeof payload.notes === "string") props.description = payload.notes;
  if (typeof payload.description === "string") props.description = payload.description;
  if (typeof payload.url === "string") props.url = payload.url;
  if (times.allDay) props.alldayEvent = true;

  var ev = Calendar.Event(props);
  targetCalendar.events.push(ev);
  Calendar.reloadCalendars();
  return { event: eventToJson(ev, cleanString(safeCall(targetCalendar, "name", null))) };
}

function updateEvent(Calendar, cfg, payload) {
  var found = findEvent(Calendar, cfg, payload || {});
  if (!found) throw new Error("event not found");
  var ev = found.event;

  if (hasOwn(payload, "title") || hasOwn(payload, "summary")) {
    var t = typeof payload.title === "string" ? payload.title : payload.summary;
    if (typeof t !== "string" || !t.trim()) throw new Error("payload.title/summary cannot be empty");
    ev.summary = t.trim();
  }

  if (hasOwn(payload, "start") || hasOwn(payload, "end") || hasOwn(payload, "allDay") || hasOwn(payload, "allday") || hasOwn(payload, "alldayEvent")) {
    var currentStart = safeCall(ev, "startDate", null);
    var currentEnd = safeCall(ev, "endDate", null);
    var merged = {
      start: hasOwn(payload, "start") ? payload.start : currentStart,
      end: hasOwn(payload, "end") ? payload.end : currentEnd,
      allDay: hasOwn(payload, "allDay") ? payload.allDay : (hasOwn(payload, "allday") ? payload.allday : (hasOwn(payload, "alldayEvent") ? payload.alldayEvent : safeCall(ev, "alldayEvent", false))),
    };
    var times = ensureEventTimes(merged);
    ev.startDate = times.start;
    ev.endDate = times.end;
    ev.alldayEvent = times.allDay;
  }

  if (hasOwn(payload, "location")) ev.location = payload.location == null ? "" : String(payload.location);
  if (hasOwn(payload, "notes") || hasOwn(payload, "description")) {
    var notes = hasOwn(payload, "notes") ? payload.notes : payload.description;
    ev.description = notes == null ? "" : String(notes);
  }
  if (hasOwn(payload, "url")) ev.url = payload.url == null ? "" : String(payload.url);

  Calendar.reloadCalendars();
  var refreshed = findEvent(Calendar, cfg, { id: found.json.id, calendar: found.json.calendar }) || found;
  return { event: refreshed.json };
}

function deleteEvent(Calendar, cfg, payload) {
  var found = findEvent(Calendar, cfg, payload || {});
  if (!found) throw new Error("event not found");
  Calendar.delete(found.event);
  Calendar.reloadCalendars();
  return { deleted: { id: found.json.id, calendar: found.json.calendar, title: found.json.title } };
}

function main() {
  var reqPath = readEnv("MYOPS_CALENDAR_REQ_PATH");
  if (!reqPath) throw new Error("MYOPS_CALENDAR_REQ_PATH missing");
  var req = JSON.parse(readTextFile(reqPath));
  var action = String(req.action || "").trim();
  var payload = req.payload && typeof req.payload === "object" ? req.payload : {};
  var cfg = req.config && typeof req.config === "object" ? req.config : {};

  var app = Application.currentApplication();
  app.includeStandardAdditions = true;
  var Calendar = Application("Calendar");

  if (action === "health") {
    var listed = listCalendars(Calendar);
    return {
      ok: true,
      action: action,
      data: {
        calendarCount: listed.count,
        calendars: listed.calendars,
      },
    };
  }
  if (action === "list_calendars") {
    return { ok: true, action: action, data: listCalendars(Calendar) };
  }
  if (action === "list_events") {
    return { ok: true, action: action, data: listEvents(Calendar, cfg, payload, action) };
  }
  if (action === "search") {
    return { ok: true, action: action, data: listEvents(Calendar, cfg, payload, action) };
  }
  if (action === "get_event") {
    var found = findEvent(Calendar, cfg, payload);
    if (!found) throw new Error("event not found");
    return { ok: true, action: action, data: { event: found.json } };
  }
  if (action === "create_event") {
    return { ok: true, action: action, data: createEvent(Calendar, cfg, payload) };
  }
  if (action === "update_event") {
    return { ok: true, action: action, data: updateEvent(Calendar, cfg, payload) };
  }
  if (action === "delete_event") {
    return { ok: true, action: action, data: deleteEvent(Calendar, cfg, payload) };
  }

  throw new Error("unsupported action: " + action);
}

try {
  var out = main();
  $.NSFileHandle.fileHandleWithStandardOutput.writeData(
    $(JSON.stringify(out) + "\n").dataUsingEncoding($.NSUTF8StringEncoding),
  );
} catch (e) {
  var msg = e && e.message ? e.message : String(e);
  $.NSFileHandle.fileHandleWithStandardOutput.writeData(
    $(JSON.stringify({ ok: false, error: msg }) + "\n").dataUsingEncoding($.NSUTF8StringEncoding),
  );
}
`;
}

async function runJxaCalendar(settings, envelope) {
  const req = {
    action: envelope.action,
    payload: settings.payload,
    config: {
      defaultCalendar: settings.defaultCalendar,
    },
  };
  const reqPath = path.join(
    os.tmpdir(),
    `myops-calendar-${Date.now()}-${Math.random().toString(16).slice(2)}.json`,
  );
  await fs.writeFile(reqPath, `${JSON.stringify(req)}\n`, "utf8");

  try {
    const result = await runCommand([settings.osascriptBin, "-l", "JavaScript"], {
      timeoutMs: settings.timeoutMs,
      input: jxaScriptSource(),
      env: {
        MYOPS_CALENDAR_REQ_PATH: reqPath,
      },
    });
    return result;
  } finally {
    await fs.rm(reqPath, { force: true }).catch(() => {});
  }
}

function envelopeOkResponse(base, extra) {
  return {
    ok: true,
    domain: "calendar",
    action: base.action,
    adapter: "macos-calendar-jxa",
    ...extra,
  };
}

function envelopeErrorResponse(base, extra) {
  return {
    ok: false,
    domain: "calendar",
    action: base.action,
    adapter: "macos-calendar-jxa",
    ...extra,
  };
}

async function dispatch(base) {
  const settings = resolveAdapterSettings(base.envelope);
  const payload = settings.payload;

  if (
    ["list_events", "search", "create_event", "update_event", "delete_event", "get_event"].includes(
      base.action,
    ) &&
    !isRecord(payload)
  ) {
    return {
      exitCode: 2,
      body: envelopeErrorResponse(base, { error: "payload must be an object" }),
    };
  }

  const startedAt = Date.now();
  const exec = await runJxaCalendar(settings, base.envelope).catch((err) => ({
    code: null,
    signal: null,
    killed: false,
    stdout: "",
    stderr: String(err),
    timeoutMs: settings.timeoutMs,
    transportError: true,
  }));
  const parsed = parseJsonOrUndefined(exec.stdout);
  const jxaOk = isRecord(parsed) && parsed.ok === true;
  const ok = !exec.transportError && exec.code === 0 && jxaOk;

  return {
    exitCode: ok ? 0 : 3,
    body: (ok ? envelopeOkResponse : envelopeErrorResponse)(base, {
      ...(isRecord(parsed) && isRecord(parsed.data) ? { data: parsed.data } : {}),
      ...(isRecord(parsed) && typeof parsed.error === "string" ? { error: parsed.error } : {}),
      result: {
        exec: {
          code: exec.code,
          signal: exec.signal,
          killed: exec.killed,
          timeoutMs: exec.timeoutMs,
          durationMs: Date.now() - startedAt,
        },
        stdoutJson: parsed,
        stderr: exec.stderr || undefined,
        stdoutRaw: parsed === undefined ? exec.stdout : undefined,
      },
    }),
  };
}

async function main() {
  const envelope = await readJsonStdin();
  if (!isRecord(envelope)) {
    writeJson({
      ok: false,
      domain: "calendar",
      adapter: "macos-calendar-jxa",
      error: "expected JSON object envelope",
    });
    process.exit(2);
    return;
  }
  const action = readString(envelope.action);
  if (!action) {
    writeJson({
      ok: false,
      domain: "calendar",
      adapter: "macos-calendar-jxa",
      error: "envelope.action required",
    });
    process.exit(2);
    return;
  }

  const supportedActions = [
    "health",
    "list_calendars",
    "list_events",
    "search",
    "get_event",
    "create_event",
    "update_event",
    "delete_event",
  ];
  if (!supportedActions.includes(action)) {
    writeJson({
      ok: false,
      domain: "calendar",
      adapter: "macos-calendar-jxa",
      action,
      error: `unsupported action '${action}'`,
      supportedActions,
    });
    process.exit(2);
    return;
  }

  const res = await dispatch({ envelope, action });
  writeJson(res.body);
  process.exit(res.exitCode);
}

main().catch((err) => {
  writeJson({
    ok: false,
    domain: "calendar",
    adapter: "macos-calendar-jxa",
    error: err instanceof Error ? err.message : String(err),
  });
  process.exit(1);
});
