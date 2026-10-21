export default {
  repositoryUrl: 'https://github.com/modestoma/dsh_channels.git',
  // main publishes stable versions to the npm `latest` dist-tag; dev publishes
  // `X.Y.Z-beta.N` prereleases to the `beta` dist-tag.
  branches: ['main', { name: 'dev', prerelease: 'beta', channel: 'beta' }],
  plugins: [
    ['@semantic-release/commit-analyzer', { preset: 'conventionalcommits' }],
    ['@semantic-release/release-notes-generator', { preset: 'conventionalcommits' }],
    '@semantic-release/npm',
    [
      '@semantic-release/github',
      { failCommentCondition: false, successCommentCondition: false },
    ],
  ],
}
