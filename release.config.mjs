export default {
  repositoryUrl: 'https://github.com/modestoma/dsh_channels.git',
  branches: ['main'],
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
