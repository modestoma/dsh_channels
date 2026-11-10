/**
 * The settings panel's {@link SettingsTarget}, assembled from the service's
 * connection lifecycle and its access, records, credential, and check parts.
 *
 * @module dsh-channels/settings/target
 */

import type { FeishuService } from '../service.ts'
import type { SettingsTarget } from './surface.ts'

/**
 * @param service - the running Feishu service.
 * @returns the panel target over it.
 */
export function settingsTarget(service: FeishuService): SettingsTarget {
  const { accessAdmin, records, profiles, credentials, checks } = service
  return {
    isRunning: () => service.isRunning(),
    isRestarting: () => service.isRestarting(),
    isConnecting: () => service.isConnecting(),
    health: () => service.health(),
    startedAtMs: () => service.startedAtMs(),
    uptimeMs: () => service.uptimeMs(),
    startError: () => service.startError(),
    scopeCheck: () => checks.scopeCheck(),
    slashCommandSync: () => checks.slashCommandSync(),
    isConfigured: () => service.isConfigured(),
    missingConfig: () => service.missingConfig(),
    refreshReadiness: () => service.refreshReadiness(),
    connect: () => service.connect(),
    takeover: () => service.takeover(),
    occupiedBy: () => service.occupiedBy(),
    configSnapshot: () => service.configSnapshot(),
    baseConfigSnapshot: () => service.baseConfigSnapshot(),
    runningConfigSnapshot: () => service.runningConfigSnapshot(),
    applyOverlay: overlay => service.applyOverlay(overlay),
    restart: () => service.restart(),
    credentialStates: () => credentials.states(),
    setCredential: (field, value) => credentials.set(field, value),
    clearCredential: field => credentials.clear(field),
    accessSnapshot: () => accessAdmin.snapshot(),
    addAccessUser: (userId, name) => accessAdmin.addUser(userId, name),
    removeAccessUser: userId => accessAdmin.removeUser(userId),
    setAccessPermission: (userId, permission, enabled) => accessAdmin.setPermission(userId, permission, enabled),
    setAccessGitEmail: (userId, gitEmail) => accessAdmin.setGitEmail(userId, gitEmail),
    resolveAccessRequest: (token, decision) => accessAdmin.resolveRequest(token, decision),
    setGroupPermission: (chatId, permission, enabled) => accessAdmin.setGroupPermission(chatId, permission, enabled),
    removeAccessGroup: chatId => accessAdmin.removeGroup(chatId),
    sessionOrigin: sessionId => records.origin(sessionId),
    feishuProfiles: (userIds, chatIds) => profiles.lookup(userIds, chatIds),
    sessionRecords: () => records.list(),
    workspaceFiles: (workspace, path) => records.files(workspace, path),
    workspaceFilePreview: (workspace, path) => records.preview(workspace, path),
    workspaceFileDownload: (workspace, path) => records.download(workspace, path),
  }
}
