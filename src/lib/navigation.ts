export function isCurrentNavigationLink(href: string, currentPath: string): boolean {
  if (href === currentPath) return true;

  if (href === '/writing/') {
    return currentPath.startsWith('/writing/') ||
      currentPath.startsWith('/archives/') ||
      /^\/\d{4}\/\d{2}\/\d{2}\//.test(currentPath);
  }

  if (href === '/projects/' || href === '/about/') {
    return currentPath.startsWith(href);
  }

  return false;
}
