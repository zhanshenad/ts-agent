import { readSkill, type SkillInfo } from "../skills.js";
import type { Tool } from "../types.js";
import { str } from "./common.js";

/** Loads a SKILL.md on demand — the skill body is never in the base prompt. */
export function makeSkillTool(skills: SkillInfo[]): Tool {
  return {
    spec: {
      name: "skill",
      description:
        "Load the full instructions of an installed skill by name. Call this before doing anything the skill covers, then follow its steps.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "Skill name exactly as listed in the system prompt." },
        },
        required: ["name"],
      },
    },
    async run(args) {
      const name = str(args, "name");
      const body = readSkill(skills, name);
      if (!body) {
        const available = skills.map((s) => s.name).join(", ") || "(none)";
        return { content: `Unknown skill "${name}". Available: ${available}`, isError: true };
      }
      return { content: body.slice(0, 60_000) };
    },
  };
}
