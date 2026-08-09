import { NavLink, Outlet } from 'react-router-dom';

/**
 * The admin section's tab bar and outlet.
 *
 * Every tab is its own deep-linkable route under /admin. Which tabs appear
 * depends on the caller: managing groups, plugins, and deployment settings is
 * super-admin work, while surveys, users, your account, and the about page are
 * open to any admin.
 *
 * @param {{user: {isSuperAdmin: boolean}}} props
 * @returns {JSX.Element} The layout.
 */
export function AdminLayout({ user }) {
  const tabs = [
    { to: '/admin/surveys', label: 'Surveys', show: true },
    { to: '/admin/users', label: 'Users', show: true },
    { to: '/admin/groups', label: 'Groups', show: user.isSuperAdmin },
    { to: '/admin/plugins', label: 'Plugins', show: user.isSuperAdmin },
    { to: '/admin/settings', label: 'Settings', show: true },
    { to: '/admin/about', label: 'About', show: true },
  ].filter((tab) => tab.show);

  return (
    <>
      <nav className="tabs admin-tabs" role="tablist" aria-label="Admin sections">
        {tabs.map((tab) => (
          <NavLink
            key={tab.to}
            to={tab.to}
            className={({ isActive }) => (isActive ? 'tab tab-on' : 'tab')}
          >
            {tab.label}
          </NavLink>
        ))}
      </nav>
      <Outlet />
    </>
  );
}
