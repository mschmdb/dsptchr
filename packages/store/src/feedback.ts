import { randomBytes } from "node:crypto";
import type { AuditLog } from "./audit.ts";
import type { Db, Row } from "./db.ts";

// Small, stable features of a notified item (source, category, domain, repo, kind, host …).
// Only operator-side facts or sanitized identifiers; never free text from the source.
export type Features = Record<string, string>;

export interface NotifiedItem {
  ref: string;
  source: string;
  externalId: string;
  features: Features;
  // Sanitized display label for the operator.
  label: string;
}

export type Verdict = "relevant" | "irrelevant" | "mute";

export interface Rule {
  id: string;
  match: Features;
  origin: string;
  state: "proposed" | "active" | "rejected";
}

const VERDICTS = new Set<Verdict>(["relevant", "irrelevant", "mute"]);

// Feedback is the operator's own judgement and therefore trusted input for triage (AR-6:
// it changes nothing by itself; rules change only when the operator activates them).
export function feedbackRepo(db: Db, audit: AuditLog, now: () => number) {
  const item = (ref: string): NotifiedItem | undefined => {
    const row = db.get("SELECT * FROM notified_items WHERE ref = :ref", { ref });
    return row === undefined ? undefined : toItem(row);
  };

  return {
    item,

    register(input: { source: string; externalId: string; features: Features; label: string }): NotifiedItem {
      return db.transaction(() => {
        const existing = db.get("SELECT * FROM notified_items WHERE source = :source AND external_id = :externalId", {
          source: input.source,
          externalId: input.externalId,
        });
        if (existing !== undefined) return toItem(existing);
        const ref = randomBytes(6).readUIntBE(0, 6).toString(36).padStart(8, "0").slice(-8);
        db.run(
          `INSERT INTO notified_items (ref, source, external_id, features_json, label, created_at)
           VALUES (:ref, :source, :externalId, :features, :label, :at)`,
          { ref, source: input.source, externalId: input.externalId, features: JSON.stringify(input.features), label: input.label, at: now() },
        );
        return item(ref) as NotifiedItem;
      });
    },

    record(ref: string, verdict: Verdict): NotifiedItem {
      if (!VERDICTS.has(verdict)) throw new Error(`unknown verdict ${verdict}`);
      return db.transaction(() => {
        const found = item(ref);
        if (found === undefined) throw new Error(`unknown item ${ref}`);
        db.run("INSERT INTO feedback (at, ref, verdict) VALUES (:at, :ref, :verdict)", { at: now(), ref, verdict });
        audit.append({ actor: "operator", event: "feedback.recorded", subject: ref, data: { verdict, source: found.source } });
        return found;
      });
    },

    // Counts per feature set, for the triage prompt.
    summary(): { features: Features; relevant: number; irrelevant: number }[] {
      return db
        .all(
          `SELECT n.features_json AS features,
                  SUM(f.verdict = 'relevant') AS relevant,
                  SUM(f.verdict IN ('irrelevant', 'mute')) AS irrelevant
           FROM feedback f JOIN notified_items n ON n.ref = f.ref
           GROUP BY n.features_json ORDER BY MAX(f.seq) DESC LIMIT 50`,
        )
        .map((r) => ({
          features: JSON.parse(String(r["features"])) as Features,
          relevant: Number(r["relevant"]),
          irrelevant: Number(r["irrelevant"]),
        }));
    },
  };
}

export function ruleRepo(db: Db, audit: AuditLog, now: () => number, newId: () => string) {
  const get = (id: string): Rule | undefined => {
    const row = db.get("SELECT * FROM rules WHERE id = :id", { id });
    return row === undefined ? undefined : toRule(row);
  };
  const active = (): Rule[] => db.all("SELECT * FROM rules WHERE state = 'active' ORDER BY created_at").map(toRule);

  return {
    get,
    active,

    propose(input: { match: Features; origin: string }): Rule {
      if (Object.keys(input.match).length === 0) throw new Error("rule match is empty");
      return db.transaction(() => {
        const id = newId();
        db.run(
          `INSERT INTO rules (id, created_at, match_json, origin, state)
           VALUES (:id, :at, :match, :origin, 'proposed')`,
          { id, at: now(), match: JSON.stringify(input.match), origin: input.origin },
        );
        audit.append({ actor: input.origin, event: "rule.proposed", subject: id, data: { match: input.match } });
        return get(id) as Rule;
      });
    },

    decide(id: string, state: "active" | "rejected", actor: string): Rule {
      return db.transaction(() => {
        const rule = get(id);
        if (rule === undefined || rule.state !== "proposed") throw new Error(`rule ${id} is not proposed`);
        db.run("UPDATE rules SET state = :state, decided_at = :at WHERE id = :id", { id, state, at: now() });
        audit.append({ actor, event: state === "active" ? "rule.activated" : "rule.rejected", subject: id });
        return get(id) as Rule;
      });
    },

    // True when an active rule's every key/value matches the item's features.
    mutes(features: Features): boolean {
      return active().some((rule) => Object.entries(rule.match).every(([key, value]) => features[key] === value));
    },
  };
}

function toItem(row: Row): NotifiedItem {
  return {
    ref: String(row["ref"]),
    source: String(row["source"]),
    externalId: String(row["external_id"]),
    features: JSON.parse(String(row["features_json"])) as Features,
    label: String(row["label"]),
  };
}

function toRule(row: Row): Rule {
  return {
    id: String(row["id"]),
    match: JSON.parse(String(row["match_json"])) as Features,
    origin: String(row["origin"]),
    state: row["state"] as Rule["state"],
  };
}
