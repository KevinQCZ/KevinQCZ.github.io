import type { CollectionEntry } from 'astro:content';

export type Project = CollectionEntry<'projects'>;

export function sortProjects(projects: Project[]): Project[] {
  return [...projects].sort((a, b) => {
    if (a.data.featured !== b.data.featured) return a.data.featured ? -1 : 1;
    return a.data.title.localeCompare(b.data.title);
  });
}

export function projectUrl(project: Project): string {
  return `/projects/${project.data.slug}/`;
}
