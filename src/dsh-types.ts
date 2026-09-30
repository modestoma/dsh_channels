/**
 * Public type barrel for the DeepSeek Harness host surface.
 *
 * The bridge used to live in this one file; it is now split by domain under
 * `src/host/` (core / agent / commands / interaction / services) and this
 * module keeps the stable import specifier for consumers and tests.
 *
 * @module dsh-channels/dsh-types
 */

export * from './host/index.ts'
