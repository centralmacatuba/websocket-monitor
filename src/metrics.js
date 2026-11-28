export const METRICS_ISSUE_TITLE = '[WebSocket Monitor][Metrics] Daily health history'

export function findMetricsIssue(issues, trustedAuthor = 'github-actions[bot]') {
  return issues.find((issue) => !issue.pull_request
    && issue.title === METRICS_ISSUE_TITLE
    && issue.user?.login === trustedAuthor) ?? null
}
