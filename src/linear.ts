import type { GroupedFinding } from "./review.ts";

const LINEAR_GRAPHQL_URL = "https://api.linear.app/graphql";

/** Only verified, explicitly deferred, high-confidence work may become backlog. */
export function eligibleLinearFollowUps(
  findings: ReadonlyArray<GroupedFinding>,
): ReadonlyArray<GroupedFinding> {
  return findings.filter(
    (finding) => finding.disposition === "follow-up" && finding.confidence === "high",
  );
}

export async function fileLinearFollowUps(input: {
  readonly findings: ReadonlyArray<GroupedFinding>;
  readonly apiKey: string;
  readonly teamId: string;
  readonly pr: string;
}): Promise<number> {
  const eligible = eligibleLinearFollowUps(input.findings);
  for (const finding of eligible) {
    const locations = finding.locations
      .map((location) => `- \`${location.file}\`${location.line > 0 ? `:${location.line}` : ""}`)
      .join("\n");
    const response = await fetch(LINEAR_GRAPHQL_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: input.apiKey,
      },
      body: JSON.stringify({
        query:
          "mutation CodeRevIssueCreate($input: IssueCreateInput!) { " +
          "issueCreate(input: $input) { success issue { id identifier title } } }",
        variables: {
          input: {
            teamId: input.teamId,
            title: finding.title,
            description: [
              `Panel-verified CodeRev follow-up from PR ${input.pr}.`,
              "",
              `Confidence: ${finding.confidence ?? ""}`,
              `Severity: ${finding.severity}`,
              "",
              locations,
              "",
              finding.detail,
              ...(finding.fix ? ["", `Suggested direction: ${finding.fix}`] : []),
            ].join("\n"),
          },
        },
      }),
    });
    const body = (await response.json().catch(() => null)) as
      | { data?: { issueCreate?: { success?: boolean } }; errors?: Array<{ message?: string }> }
      | null;
    if (!response.ok || body?.errors?.length || body?.data?.issueCreate?.success !== true) {
      const detail = body?.errors?.map((error) => error.message).filter(Boolean).join("; ");
      throw new Error(`Linear issue creation failed (${response.status})${detail ? `: ${detail}` : ""}`);
    }
  }
  return eligible.length;
}
