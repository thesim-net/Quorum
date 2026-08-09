import { AdminUsers } from './AdminUsers.jsx';

/**
 * Users tab: admin access management.
 *
 * The card carries the actual behaviour; this just gives it a page heading and
 * shell now that it has its own tab rather than sharing the settings page.
 *
 * @returns {JSX.Element} The page.
 */
export function AdminUsersPage() {
  return (
    <div className="shell">
      <h1>Users</h1>
      <AdminUsers />
    </div>
  );
}
