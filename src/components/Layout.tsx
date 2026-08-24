import {
  Archive,
  Boxes,
  Cloud,
  ChevronLeft,
  Database,
  GitBranch,
  History,
  Languages,
  LayoutDashboard,
  Menu,
  Moon,
  LogOut,
  Settings,
  Sun,
  X,
} from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { NavLink, useLocation } from "react-router-dom";
import { useToast } from "./Toast";
import { usePreferences } from "../preferences";
import { useAuth } from '../auth';

const nav = [
  ["dashboard", "/", LayoutDashboard],
  ["repositories", "/repositories", GitBranch],
  ["backups", "/backups", Archive],
  ["history", "/history", History],
  ["storage", "/storage", Database],
  ["destinations", "/destinations", Cloud],
  ["settings", "/settings", Settings],
] as const;
export default function Layout({ children }: { children: ReactNode }) {
  const { t, i18n } = useTranslation();
  const toast = useToast();
  const { settings, saveSettings, resolvedTheme } = usePreferences();
  const { user, logout } = useAuth();
  const [open, setOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(
    localStorage.getItem("backmygit-sidebar") === "collapsed",
  );
  const location = useLocation();
  useEffect(() => setOpen(false), [location.pathname]);
  const language = async () => {
    if (!settings) return;
    const next = i18n.language.startsWith("es") ? "en" : "es";
    try {
      await saveSettings({ ...settings, language: next });
    } catch {
      toast(t("unexpectedError"), "error");
    }
  };
  const toggleTheme = async () => {
    if (!settings) return;
    const next =
      resolvedTheme === "dark" ? "light" : "dark";
    try {
      await saveSettings({ ...settings, appearance: next });
    } catch {
      toast(t("unexpectedError"), "error");
    }
  };
  const toggleCollapse = () => {
    setCollapsed((x) => {
      localStorage.setItem("backmygit-sidebar", !x ? "collapsed" : "open");
      return !x;
    });
  };
  return (
    <div className={`shell ${collapsed ? "collapsed" : ""}`}>
      <aside className={open ? "open" : ""}>
        <div className="brand">
          <div className="brand-mark">
            <Boxes />
          </div>
          <div>
            <b>BackMyGit</b>
            <small>{t("brandTagline")}</small>
          </div>
          <button
            className="mobile-close"
            onClick={() => setOpen(false)}
            aria-label={t("close")}
          >
            <X />
          </button>
        </div>
        <nav>
          {nav.map(([key, to, Icon]) => (
            <NavLink
              key={key}
              to={to}
              end={to === "/"}
              title={collapsed ? t(key) : undefined}
            >
              <Icon />
              <span>{t(key)}</span>
            </NavLink>
          ))}
        </nav>
        <button
          className="collapse"
          onClick={toggleCollapse}
          aria-label={t("collapseMenu")}
        >
          <ChevronLeft />
          <span>{t("collapseMenu")}</span>
        </button>
      </aside>
      <div
        className={`scrim ${open ? "show" : ""}`}
        onClick={() => setOpen(false)}
      />
      <div className="main">
        <header>
          <button
            className="mobile-menu icon-button"
            onClick={() => setOpen(true)}
            aria-label={t("openMenu")}
          >
            <Menu />
          </button>
          <div className="header-brand">
            <Boxes />
            <b>BackMyGit</b>
          </div>
          <div className="header-actions">
            <span className="current-user"><b>{user?.username}</b><small>{user?.role}</small></span>
            <button
              className="header-button"
              onClick={() => void language()}
              title={t("switchLanguage")}
            >
              <Languages />
              <span>{i18n.language.startsWith("es") ? "ES" : "EN"}</span>
            </button>
            <button className="icon-button" onClick={() => void logout()} title={t('signOut')}><LogOut /></button>
            <button
              className="icon-button"
              onClick={() => void toggleTheme()}
              title={t("switchTheme")}
            >
              {resolvedTheme === "dark" ? (
                <Sun />
              ) : (
                <Moon />
              )}
            </button>
          </div>
        </header>
        <main>{children}</main>
      </div>
    </div>
  );
}
