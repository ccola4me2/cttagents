// Say a failure where it can be read without signing in.
//
// An Actions log is only readable by somebody with access to the repository
// signed into GitHub. The thing that most often needs to read it is whatever
// is working out why the push went red, and on this project that has meant
// reproducing each checker by hand to guess at the answer.
//
// Annotations are not like that. They hang off the run, they show on the
// summary page above the log, and the check-runs API hands them to anybody who
// can see a public repository. So every checker says its failures twice: once
// in the log for a person reading it, once here.
//
// Only when CI is set, so a local run stays quiet.

/** A workflow command is one line, so newlines are escaped rather than lost. */
function oneLine(s) {
  return String(s)
    .replace(/%/g, '%25')
    .replace(/\r/g, '%0D')
    .replace(/\n/g, '%0A');
}

export function annotate(title, message) {
  if (!process.env.CI) return;
  console.log(`::error title=${oneLine(title)}::${oneLine(message)}`);
}

/**
 * The end of a checker: say what failed, annotate each one, and set the exit
 * code. Returns nothing because it does not come back when anything failed.
 */
export function report(name, problems, describe = String) {
  if (!problems.length) return;
  for (const p of problems) annotate(name, describe(p));
  process.exit(1);
}
