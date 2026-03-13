
export function normalize(s: string): string {
  // Remove spaces, parens, hyphens, underscores — normalize both sides
  return s.toLowerCase().replace(/[\s()\-_]/g, '');
}

export function detectTestedFunctions(
  specContent: string,
  exportedFunctions: string[]
): string[] {
  const tested: string[] = [];

  for (const fn of exportedFunctions) {
    const normalizedFn = normalize(fn);

    // 1. Exact match in any describe block at any nesting depth
    const describePattern = new RegExp(
      `describe\\s*\\(\\s*['"\`]${fn}['"\`]`, 'i'
    );

    // 2. Substring match in test/it titles — catches "should createUser when..."
    const testItPattern = new RegExp(
      `(?:test|it)\\s*\\(\\s*['"\`][^'"\`]*${fn}[^'"\`]*['"\`]`, 'i'
    );

    // 3. Normalized substring match on both sides — catches "create-user", "create user"
    const normalizedMatch = specContent
      .split('\n')
      .some(line => normalize(line).includes(normalizedFn));

    // 4. Function name appears anywhere in spec — catches class-level describe
    //    blocks where function name is in test body or import but not in titles
    //    e.g. describe('UserService') with createUser called inside test bodies
    const anywhereMatch = normalize(specContent).includes(normalizedFn);

    if (
      describePattern.test(specContent) ||
      testItPattern.test(specContent)   ||
      normalizedMatch                   ||
      anywhereMatch
    ) {
      tested.push(fn);
    }
  }

  return tested;
}