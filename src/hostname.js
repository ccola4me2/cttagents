// Which host a request is for.
//
// A leaf, and nothing but this: the sign in and the group domain's router both need the answer, and neither can
// import the other.
//
// The address in the request, except under the test server. There, and only there, a header can say which host
// the request is for, because the test server answers on one address and the group domain's behaviour is
// otherwise impossible to exercise. TEST_HOSTS is set by the test run's own startup and by nothing else, so on the
// live site the header is ignored.

export function hostOf(request, env) {
  if (env && env.TEST_HOSTS === '1') {
    const said = request.headers.get('x-test-host');
    if (said) return String(said).trim().toLowerCase();
  }
  return new URL(request.url).hostname.toLowerCase();
}
