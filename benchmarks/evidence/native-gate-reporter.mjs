// Machine-readable accounting from the real Node test runner, not TAP regexes.
export default async function* reporter(source) {
  for await (const { type, data } of source) {
    if (type === 'test:pass' || type === 'test:fail') {
      yield `${JSON.stringify({ type, name: data.name, kind: data.details.type,
        skip: data.skip ?? false, todo: data.todo ?? false })}\n`;
    } else if (type === 'test:summary' && !data.file) {
      yield `${JSON.stringify({ type, counts: data.counts, success: data.success })}\n`;
    }
  }
}
