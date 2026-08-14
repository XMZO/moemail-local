export const ROLES = {
  EMPEROR: 'emperor',
  DUKE: 'duke',
  KNIGHT: 'knight',
  CIVILIAN: 'civilian',
} as const;

export type Role = typeof ROLES[keyof typeof ROLES];

export const PERMISSIONS = {
  VIEW_EMAIL: 'view_email',
  CREATE_EMAIL: 'create_email',
  DELETE_EMAIL: 'delete_email',
  RECEIVE_EMAIL: 'receive_email',
  SEND_EMAIL: 'send_email',
  PRIVATE_RECIPIENT_DELIVERY: 'private_recipient_delivery',
  SHARE_EMAIL: 'share_email',
  MANAGE_WEBHOOK: 'manage_webhook',
  PROMOTE_USER: 'promote_user',
  MANAGE_CONFIG: 'manage_config',
  MANAGE_MAILU: 'manage_mailu',
  MANAGE_API_KEY: 'manage_api_key',
} as const;

export type Permission = typeof PERMISSIONS[keyof typeof PERMISSIONS];

export const ROLE_PERMISSIONS: Record<Role, Permission[]> = {
  [ROLES.EMPEROR]: Object.values(PERMISSIONS),
  [ROLES.DUKE]: [
    PERMISSIONS.VIEW_EMAIL,
    PERMISSIONS.CREATE_EMAIL,
    PERMISSIONS.DELETE_EMAIL,
    PERMISSIONS.RECEIVE_EMAIL,
    PERMISSIONS.SEND_EMAIL,
    PERMISSIONS.PRIVATE_RECIPIENT_DELIVERY,
    PERMISSIONS.SHARE_EMAIL,
    PERMISSIONS.MANAGE_WEBHOOK,
    PERMISSIONS.MANAGE_API_KEY,
  ],
  [ROLES.KNIGHT]: [
    PERMISSIONS.VIEW_EMAIL,
    PERMISSIONS.CREATE_EMAIL,
    PERMISSIONS.DELETE_EMAIL,
    PERMISSIONS.RECEIVE_EMAIL,
    PERMISSIONS.SEND_EMAIL,
    PERMISSIONS.PRIVATE_RECIPIENT_DELIVERY,
    PERMISSIONS.SHARE_EMAIL,
    PERMISSIONS.MANAGE_WEBHOOK,
  ],
  [ROLES.CIVILIAN]: [],
} as const;

export function hasPermission(userRoles: Role[], permission: Permission): boolean {
  return userRoles.some(role => ROLE_PERMISSIONS[role]?.includes(permission));
}
