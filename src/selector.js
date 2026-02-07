import prompts from 'prompts';

/**
 * Prompt the user to select which projects to analyse.
 * If `skipSelection` is true or there is only one project, return all.
 * Returns the filtered array of project objects.
 */
export async function selectProjects(projects, { skipSelection = false } = {}) {
  if (projects.length === 0) return [];
  if (projects.length === 1 || skipSelection) return projects;

  const { selected } = await prompts({
    type: 'autocompleteMultiselect',
    name: 'selected',
    message: 'Select projects to analyse (type to search)',
    choices: projects.map((p, i) => ({
      title: `${p.name} (${p.relativePath})`,
      value: i,
      selected: false,
    })),
    hint: '- Type to filter, Space to toggle, Enter to submit',
  });

  // If the user cancels (Ctrl-C), selected will be undefined
  if (!selected) {
    process.exit(0);
  }

  return selected.map((i) => projects[i]);
}
