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

export default function App(){return <Layout><Routes>
  <Route path="/" element={<Dashboard/>}/><Route path="/repositories" element={<Repositories/>}/><Route path="/repositories/new" element={<AddRepositories/>}/><Route path="/repositories/:id" element={<RepositoryDetail/>}/>
  <Route path="/backups" element={<Backups/>}/><Route path="/history" element={<HistoryPage/>}/><Route path="/storage" element={<Storage/>}/><Route path="/settings" element={<SettingsPage/>}/><Route path="*" element={<Navigate to="/" replace/>}/>
</Routes></Layout>}
