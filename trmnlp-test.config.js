// trmnlp-test configuration. Every key is optional.
module.exports = {
  plugin: 'plugin', // the trmnlp project: src/ (settings.yml, *.liquid, transform.*) and .trmnlp.yml
  tests: 'test/trmnl', // *.spec.js files
  report: 'test/trmnl-report', // index.html gallery + html/ Playwright report

  // applied to every render/transform unless the test overrides it
  defaults: {
    device: 'og_plus', // any model from https://trmnl.com/api/models (trmnlp-test models)
    view: 'full', // full | half_horizontal | half_vertical | quadrant
    now: '2026-10-02T08:00:00Z', // fixed clock: transform, Liquid and the page all see it
    timeZone: 'Europe/Brussels',
  },

  serverless: {
    // packages the transform imports, besides the hosted built-ins (requests, httparty)
    dependencies: {
      // python: ['icalendar==6.1.0'],   or 'requirements.txt'
      // ruby: ['nokogiri'],             or 'Gemfile'
      // node: ['date-fns@4'],           or 'package.json'
      // php: ['nesbot/carbon:^3'],      or 'composer.json'
    },
    network: 'mock', // unmocked requests fail; 'live' lets them through
    timeoutMs: 5000, // the hosted limit
  },

  screenshots: 'always', // device pictures in the report: always | on-failure | never

  // parallel test workers (each runs its own harness and browser): a number or '50%' of the CPUs.
  // Default: half the CPUs. Overridden by TRMNLP_TEST_WORKERS, and that by --workers / -j.
  // workers: 4,
};
