import * as fs from "node:fs";
import * as path from "node:path";
import type { FlowPlan } from "../types/output.js";

function slugify(s: string): string {
	return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "plan";
}

/** Persist a craft plan to <cwd>/.pi/plans/<ts>-<slug>.md. Returns the absolute path. */
export function writePlanArtifact(cwd: string, plan: FlowPlan): string {
	const dir = path.join(cwd, ".pi", "plans");
	fs.mkdirSync(dir, { recursive: true });
	const file = path.join(dir, `${Date.now()}-${slugify(plan.title)}.md`);
	const body = [
		`# ${plan.title}`,
		"",
		...plan.tasks.flatMap((t, i) => [
			`## Task ${i + 1}: ${t.intent}`,
			`- Files: ${t.files.join(", ")}`,
			`- Verify: \`${t.verify}\``,
			`- Rollback: \`${t.rollback}\``,
			"",
		]),
	].join("\n");
	fs.writeFileSync(file, body, "utf8");
	return file;
}
