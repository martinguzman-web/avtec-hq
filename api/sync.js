// Avtec HQ — Airtable → Webflow portal sync (Vercel serverless function).
// GET /api/sync?id=<AircraftRecordId>   syncs one aircraft (+ its stations & change orders)
// GET /api/sync                          syncs every aircraft flagged "Push to Portal"
//
// DESIGN PRINCIPLES (so portal redesigns / additions never break the pipe):
//  • Writes to Webflow by FIELD SLUG, with PARTIAL PATCH — only the mapped fields are touched.
//    Anything you redesign in the Webflow Designer, or any new field you add on either side,
//    is left untouched. The sync never deletes or overwrites unmapped data.
//  • Matches records by stored Webflow Item ID (never creates duplicates). If an Airtable
//    record has no Webflow Item ID yet, it creates the item and writes the new ID back to Airtable.
//  • Progress photos are intentionally NOT synced — manage images directly in Webflow; the sync
//    leaves that field alone so your gallery is never clobbered.
//  • Tolerant of empty values and missing children.

const AT_BASE = "appse83xW0hUu10rB";
const WF_SITE = "623c9589f6bbcb4044e11cb5";
const C = { proj: "6a42ae3f53eb0eac460c3174", stn: "6a42d7b11a80a62ff298fa30", co: "6a42e6048a84cbe577d9ec87" };
const T = { air: "tblIfRcP9in4gHFVz", stn: "tbloWOiMvK4goyUUM", co: "tblIebqCXdDZmBf87" };

// Webflow option-field value IDs (write the ID, not the label)
const PHASE_OPT = { "Quoted": "42ecde08ece50f18fc33a17d5196f394", "Approved": "17d8a17289aa5c1e915b17b8fdf30c27", "On Dock": "be7f75fefe18c0eeb6e5c996c870944a", "In Build": "c274c7ea65f60a4155edc995c42bc672", "Finishing": "a1f41b9e533b6482a848a1168e97186e", "Delivery": "74e33114effbf3e305e3271bc465f13f" };
const STATE_OPT = { "In craft": "59c63b7f26f2cbf8e71e43314b2fcbf4", "Staged": "a8d32483c02fc942517d3430f858b6f5", "Queued": "de534ea76cfe10b227f1929ad71bd8db", "Complete": "3b385787393b8c424de08ff34f88bc53" };
const COST_OPT = { "Approved": "7af2ca013158378671bb33c1752d3cf3", "Pending": "c9e230a4695adfa07692f371af41d8fd", "Declined": "c447af4daf54cef3dfff515a8a69ab38" };

const MONTHS = ["January","February","March","April","May","June","July","August","September","October","November","December"];
const MShort = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

module.exports = async function handler(req, res) {
  const AT = process.env.AIRTABLE_TOKEN, WF = process.env.WEBFLOW_TOKEN;
  if (!AT) return res.status(500).json({ error: "Missing AIRTABLE_TOKEN" });
  if (!WF) return res.status(500).json({ error: "Missing WEBFLOW_TOKEN — add it in Vercel env vars" });
  const atH = { Authorization: "Bearer " + AT, "Content-Type": "application/json" };
  const wfH = { Authorization: "Bearer " + WF, "Content-Type": "application/json", "accept-version": "2.0.0" };

  // ---------- helpers ----------
  const atGet = async (table, q = "") => (await (await fetch(`https://api.airtable.com/v0/${AT_BASE}/${table}?pageSize=100${q}`, { headers: atH })).json());
  const atPatch = (table, id, fields) => fetch(`https://api.airtable.com/v0/${AT_BASE}/${table}/${id}`, { method: "PATCH", headers: atH, body: JSON.stringify({ fields }) });
  const wfPatch = (cid, itemId, fieldData) => fetch(`https://api.webflow.com/v2/collections/${cid}/items/${itemId}`, { method: "PATCH", headers: wfH, body: JSON.stringify({ fieldData }) });
  const wfCreate = (cid, fieldData) => fetch(`https://api.webflow.com/v2/collections/${cid}/items`, { method: "POST", headers: wfH, body: JSON.stringify({ fieldData }) });
  const wfPublish = (cid, ids) => fetch(`https://api.webflow.com/v2/collections/${cid}/items/publish`, { method: "POST", headers: wfH, body: JSON.stringify({ itemIds: ids }) });

  const fv = (rec, name) => { const v = rec.fields ? rec.fields[name] : undefined; if (v == null) return ""; if (typeof v === "object" && !Array.isArray(v)) return v.name != null ? v.name : ""; return v; };
  const money = (n, plus) => { n = Number(n || 0); return (plus && n > 0 ? "+$" : "$") + Math.round(n).toLocaleString("en-US"); };
  const longDate = (iso) => { if (!iso) return ""; const d = new Date(iso + "T12:00:00"); if (isNaN(d)) return iso; return MShort[d.getMonth()] + " " + d.getDate() + ", " + d.getFullYear(); };
  const today = () => { const d = new Date(); return MONTHS[d.getMonth()] + " " + d.getDate() + ", " + d.getFullYear(); };
  const esc = (s) => String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const lines = (t) => String(t || "").split(/\n/).map(s => s.trim()).filter(Boolean);
  const paras = (t) => lines(t).map(l => "<p>" + esc(l) + "</p>").join("");
  const bullets = (t) => { const L = lines(t); return L.length ? "<ul>" + L.map(l => "<li>" + esc(l) + "</li>").join("") + "</ul>" : ""; };
  const slugify = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "item";

  // upsert a Webflow item; returns the item id (creating + writing the id back to Airtable if needed)
  async function upsert(cid, atTable, atRec, idFieldName, fieldData) {
    let wid = fv(atRec, idFieldName);
    if (wid) { const r = await wfPatch(cid, wid, fieldData); if (!r.ok) throw new Error(`WF patch ${cid} ${wid}: ${r.status} ${await r.text()}`); return wid; }
    const r = await wfCreate(cid, fieldData); if (!r.ok) throw new Error(`WF create ${cid}: ${r.status} ${await r.text()}`);
    const j = await r.json(); wid = j.id;
    await atPatch(atTable, atRec.id, { [idFieldName]: wid });   // write the new Webflow ID back to Airtable
    return wid;
  }

  // ---------- sync one aircraft ----------
  async function syncAircraft(air, allStations, allCOs) {
    const slug = fv(air, "Portal Slug") || slugify(fv(air, "Aircraft"));
    const phase = fv(air, "Current Phase");
    const childOf = (rows) => rows.filter(r => Array.isArray(r.fields.Aircraft) && r.fields.Aircraft.includes(air.id))
                                  .sort((a, b) => (Number(fv(a, "Sort Order")) || 0) - (Number(fv(b, "Sort Order")) || 0));
    const stations = childOf(allStations);
    const cos = childOf(allCOs);

    // change-orders-list richtext, generated from the linked Change Orders
    const coListHtml = cos.length ? "<ul>" + cos.map(c => "<li>" + esc(fv(c, "Change Order")) + " — " + esc(money(fv(c, "Amount"), true)) + " (" + esc(fv(c, "Status")) + ")</li>").join("") + "</ul>" : "";

    // 1) Portal Projects item (partial — only these slugs are written)
    const projData = {
      name: fv(air, "Aircraft") + (fv(air, "Client Name") ? " — " + fv(air, "Client Name") : ""),
      slug,
      "aircraft": fv(air, "Aircraft"),
      "client-name": fv(air, "Client Name"),
      "client-email": fv(air, "Client Email"),
      "access-code": fv(air, "Access Code"),
      "scope-summary": fv(air, "Scope Summary"),
      "current-phase": PHASE_OPT[phase] || undefined,
      "current-phase-title": fv(air, "Phase Title") || phase,
      "current-phase-note": paras(fv(air, "Phase Note")),
      "on-dock-date": longDate(fv(air, "On Dock Date")),
      "est-completion": longDate(fv(air, "Est Completion")),
      "schedule-status": fv(air, "Schedule Status"),
      "project-lead": fv(air, "Project Lead"),
      "project-lead-note": fv(air, "Project Lead Note"),
      "aircraft-location": fv(air, "Aircraft Location"),
      "contract-base": money(fv(air, "Contract Base")),
      "change-orders-total": money(fv(air, "Change Orders Total"), true),
      "current-total": money(fv(air, "Current Total")),
      "materials-list": bullets(fv(air, "Materials List")),
      "activity-log": paras(fv(air, "Activity Log")),
      "change-orders-list": coListHtml,
      "delivered-archived": !!air.fields["Delivered / Archived"],
      "last-updated": today(),
    };
    Object.keys(projData).forEach(k => projData[k] === undefined && delete projData[k]);
    const projId = await upsert(C.proj, T.air, air, "Webflow Item ID", projData);

    // 2) Workstations
    const stnIds = [];
    for (const s of stations) {
      const data = {
        name: fv(s, "Station"), slug: slugify(fv(s, "Station")) + "-" + air.id.slice(-6),
        artisan: fv(s, "Artisan"), detail: fv(s, "Detail"),
        progress: Math.max(0, Math.min(100, Number(fv(s, "Progress")) || 0)),
        "sort-order": Number(fv(s, "Sort Order")) || 0,
        state: STATE_OPT[fv(s, "State")] || undefined, project: projId,
      };
      Object.keys(data).forEach(k => data[k] === undefined && delete data[k]);
      stnIds.push(await upsert(C.stn, T.stn, s, "Webflow Item ID", data));
    }

    // 3) Change Orders
    const coIds = [];
    for (const c of cos) {
      const data = {
        name: fv(c, "Change Order"), slug: slugify(fv(c, "Change Order")) + "-" + air.id.slice(-6),
        amount: money(fv(c, "Amount"), true),
        "sort-order": Number(fv(c, "Sort Order")) || 0,
        status: COST_OPT[fv(c, "Status")] || undefined, project: projId,
        // mirror fields for the existing email automation, pulled from the parent aircraft:
        "client-email": fv(air, "Client Email"), "aircraft": fv(air, "Aircraft"), "portal-slug": slug,
      };
      Object.keys(data).forEach(k => data[k] === undefined && delete data[k]);
      coIds.push(await upsert(C.co, T.co, c, "Webflow Item ID", data));
    }

    // 4) publish everything so the portal reflects it immediately
    await wfPublish(C.proj, [projId]);
    if (stnIds.length) await wfPublish(C.stn, stnIds);
    if (coIds.length) await wfPublish(C.co, coIds);

    // 5) reset the Push to Portal flag in Airtable
    await atPatch(T.air, air.id, { "Push to Portal": false });

    return { aircraft: fv(air, "Aircraft"), projId, stations: stnIds.length, changeOrders: coIds.length };
  }

  // ---------- run ----------
  try {
    const id = (req.query && req.query.id) || "";
    const [airAll, stnAll, coAll] = await Promise.all([atGet(T.air), atGet(T.stn), atGet(T.co)]);
    let targets = airAll.records || [];
    if (id) targets = targets.filter(r => r.id === id);
    else targets = targets.filter(r => r.fields["Push to Portal"] === true);
    if (!targets.length) return res.status(200).json({ ok: true, message: "Nothing to sync.", synced: [] });
    const out = [];
    for (const air of targets) out.push(await syncAircraft(air, stnAll.records || [], coAll.records || []));
    return res.status(200).json({ ok: true, synced: out });
  } catch (e) {
    return res.status(500).json({ error: String(e && e.message || e) });
  }
};
