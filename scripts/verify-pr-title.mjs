#!/usr/bin/env node
import { assertConventionalSubject } from './verify-conventional.mjs'

const prTitle = process.env.PR_TITLE?.trim() ?? ''

// Handle multi-line titles or titles containing merge commit messages
// Extract the first line that looks like a conventional commit
const lines = prTitle.split('\n')
let validTitle = null

for (const line of lines) {
  const trimmed = line.trim()
  if (trimmed && /^(feat|fix|docs|test|refactor|chore|ci)/.test(trimmed)) {
    validTitle = trimmed
    break
  }
}

// If we found a valid conventional commit line, use it; otherwise use the original title
const titleToValidate = validTitle ?? prTitle

assertConventionalSubject(titleToValidate, 'pull request title')
