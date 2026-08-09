/**
 * Copyright (c) HashiCorp, Inc.
 * SPDX-License-Identifier: MPL-2.0
 */

module.exports = ({
  context,
  github,
  planOutcome,
  pusher,
  actionName,
  workflowName,
  workingDirectory,
  stackName,
}) => {
  const { readFileSync } = require("fs");
  if (!/^[a-z0-9-]+$/.test(stackName)) {
    throw new Error(`Refusing to read plan for unsafe stack name: ${stackName}`);
  }
  const data = readFileSync(`./plan_stdout_${stackName}.txt`, "utf-8");
  const isLargeOutput = data.length > 65000;
  const refreshLinesRegex = /: Refreshing state\.\.\.\s*\[id=/i;

  let plan = data;
  if (isLargeOutput)
    plan = plan
      .split("\n")
      .filter((line) => !refreshLinesRegex.test(line))
      .join("\n");

  plan = plan.length > 65000 ? `${plan.substring(0, 65000)}...` : plan;

  const remoteRunLinkRegex = /^(.*app\.terraform\.io\/app.*)$/m;
  const remoteRunLinkMatch = remoteRunLinkRegex.exec(plan);
  const remoteRunLink =
    remoteRunLinkMatch !== null ? remoteRunLinkMatch[1] : null;

  const output = `#### [\`${stackName}\`] Terraform Plan 📖\`${planOutcome}\`

${
  remoteRunLink
    ? `<a href="${remoteRunLink}" target="_blank">Remote Plan Link ↗️</a>`
    : ""
}

<details><summary>Show Plan</summary>

\`\`\`tf
${plan}
\`\`\`

</details>

*Pusher: @${pusher}, Action: \`${actionName}\`, Working Directory: \`${workingDirectory}\`, Workflow: \`${workflowName}\`*`;

  github.rest.issues.createComment({
    issue_number: context.issue.number,
    owner: context.repo.owner,
    repo: context.repo.repo,
    body: output,
  });
};
