import type {
  IndexStatus,
  RepositoryFacts,
  RepositoryOverview,
  RepositorySnapshot,
} from './types.js';

export function buildRepositoryOverview(
  snapshot: RepositorySnapshot,
  status: IndexStatus,
  maxTokens: number,
): RepositoryOverview {
  const sections = overviewSections(snapshot.facts, snapshot, status);
  const maxChars = Math.max(512, maxTokens * 4);
  const selected: string[] = [];
  let used = 0;
  for (const section of sections) {
    if (used + section.length + 2 > maxChars) continue;
    selected.push(section);
    used += section.length + 2;
  }
  if (selected.length === 0) {
    selected.push(
      [
        'Repository',
        `- Index: ${status.state}; coverage ${Math.round(status.coverage * 100)}%`,
        `- Files: ${status.indexedFiles}/${status.discoveredFiles}`,
      ].join('\n'),
    );
  }
  const content = `${selected.join('\n\n')}${
    selected.length < sections.length ? '\n\n- Overview truncated to its token budget.' : ''
  }`;
  return {
    version: `${snapshot.generation}:${status.state}:${status.staleFiles}`,
    content,
    status,
  };
}

function overviewSections(
  facts: RepositoryFacts,
  snapshot: RepositorySnapshot,
  status: IndexStatus,
): string[] {
  const hotspots = dependencyHotspots(snapshot);
  return [
    [
      'Repository',
      `- Index: ${status.state}; coverage ${Math.round(status.coverage * 100)}%; generation ${shortGeneration(snapshot.generation)}`,
      `- Files: ${status.indexedFiles} indexed / ${status.discoveredFiles} discovered; ${status.failedFiles} failed; ${status.staleFiles} stale`,
      ...(status.warnings.length ? [`- Warnings: ${status.warnings.join('; ')}`] : []),
    ].join('\n'),
    listSection('Stack and manifests', [
      ...(facts.stacks.length ? [`Stacks: ${facts.stacks.join(', ')}`] : []),
      ...facts.manifests.map((path) => `Manifest: ${path}`),
    ]),
    listSection('Workspaces / packages', facts.workspaces),
    listSection('Entrypoints', facts.entrypoints),
    listSection(
      'Build and test commands',
      facts.commands.map(({ name, command }) => `${name}: ${command}`),
    ),
    listSection('Top-level modules', facts.topLevelModules),
    listSection('Dependency hotspots', hotspots),
  ].filter((section) => section.length > 0);
}

function dependencyHotspots(snapshot: RepositorySnapshot): string[] {
  const counts = new Map<string, { incoming: number; outgoing: number }>();
  for (const edge of snapshot.dependencies) {
    const from = counts.get(edge.from) ?? { incoming: 0, outgoing: 0 };
    from.outgoing++;
    counts.set(edge.from, from);
    if (edge.to) {
      const to = counts.get(edge.to) ?? { incoming: 0, outgoing: 0 };
      to.incoming++;
      counts.set(edge.to, to);
    }
  }
  return [...counts]
    .sort(
      (left, right) =>
        right[1].incoming + right[1].outgoing - (left[1].incoming + left[1].outgoing) ||
        left[0].localeCompare(right[0]),
    )
    .slice(0, 12)
    .map(([path, count]) => `${path} (in ${count.incoming}, out ${count.outgoing})`);
}

function listSection(title: string, values: readonly string[]): string {
  if (values.length === 0) return '';
  return [title, ...values.slice(0, 40).map((value) => `- ${value}`)].join('\n');
}

function shortGeneration(generation: string): string {
  return generation === 'none' ? generation : generation.slice(0, 12);
}
