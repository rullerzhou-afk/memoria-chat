/**
 * Extract a terminal handler from an Express Router's internal stack.
 * Usage: extractHandler(router, 'post', '/memory/auto-learn')
 */
function extractHandler(router, method, routePath) {
  method = method.toLowerCase();
  for (const layer of router.stack) {
    if (
      layer.route &&
      layer.route.path === routePath &&
      layer.route.methods[method]
    ) {
      // Return the last handler in the stack (the terminal one)
      const handlers = layer.route.stack.filter((s) => s.method === method);
      return handlers[handlers.length - 1]?.handle;
    }
  }
  throw new Error(`Handler not found: ${method.toUpperCase()} ${routePath}`);
}

module.exports = { extractHandler };
