
export function normalize(s: string): string {
  // Remove spaces, parens, hyphens, underscores — normalize both sides
  return s.toLowerCase().replace(/[\s()\-_]/g, '');
}

export function detectTestedFunctions(
  specContent: string,
  exportedFunctions: string[]
): string[] {
  const tested: string[] = [];

  // Only look inside SS-GENERATED block — ignore imports and user tests
  const generatedMatch = specContent.match(
    /\/\/ <SS-GENERATED-START>([\s\S]*?)\/\/ <SS-GENERATED-END>/
  );
  const generatedBlock = generatedMatch?.[1] ?? '';

  // Also check SS-USER-TESTS block
  const userTestsMatch = specContent.match(
    /\/\/ <SS-USER-TESTS>([\s\S]*?)\/\/ <\/SS-USER-TESTS>/
  );
  const userTestsBlock = userTestsMatch?.[1] ?? '';

  const searchContent = generatedBlock + '\n' + userTestsBlock;

  for (const fn of exportedFunctions) {
    // 1. Exact describe block title match
    const describePattern = new RegExp(
      `describe\\s*\\(\\s*['"\`]${fn}['"\`]`, 'i'
    );

    // 2. Function name appears as standalone word in test/it title only
    const testItPattern = new RegExp(
      `(?:test|it)\\s*\\(\\s*['"\`][^'"\`]*\\b${fn}\\b[^'"\`]*['"\`]`, 'i'
    );

    if (
      describePattern.test(searchContent) ||
      testItPattern.test(searchContent)
    ) {
      tested.push(fn);
    }
  }

  return tested;
}