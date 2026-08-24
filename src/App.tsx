import { Navigate, Route, Routes } from 'react-router-dom';
import Layout from './components/Layout';
import Dashboard from './pages/Dashboard';
import Repositories from './pages/Repositories';
import AddRepositories from './pages/AddRepositories';
import RepositoryDetail from './pages/RepositoryDetail';
import Backups from './pages/Backups';
import HistoryPage from './pages/History';
import Storage from './pages/Storage';
import SettingsPage from './pages/Settings';
import Destinations from './pages/Destinations';
import { useAuth } from './auth';
import { AuthLoading, LoginPage, SetupPage } from './pages/Auth';
import { PreferencesProvider } from './preferences';

function AuthenticatedApp(){return <PreferencesProvider><Layout><Routes>
  <Route path="/" element={<Dashboard/>}/><Route path="/repositories" element={<Repositories/>}/><Route path="/repositories/new" element={<AddRepositories/>}/><Route path="/repositories/:id" element={<RepositoryDetail/>}/>
  <Route path="/backups" element={<Backups/>}/><Route path="/history" element={<HistoryPage/>}/><Route path="/storage" element={<Storage/>}/><Route path="/destinations" element={<Destinations/>}/><Route path="/settings" element={<SettingsPage/>}/><Route path="*" element={<Navigate to="/" replace/>}/>
</Routes></Layout></PreferencesProvider>}

export default function App(){const{state}=useAuth();if(state==='loading')return <AuthLoading/>;if(state==='setup')return <SetupPage/>;if(state==='anonymous')return <LoginPage/>;return <AuthenticatedApp/>}
