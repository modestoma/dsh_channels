#!/usr/bin/env node
import { assertConventionalSubject } from './verify-conventional.mjs'

assertConventionalSubject(process.env.PR_TITLE?.trim() ?? '', 'pull request title')
