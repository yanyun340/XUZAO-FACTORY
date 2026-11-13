import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from './App';
import './styles/tokens.css';
import './styles/base.css';
import './styles/components.css';
import './styles/layout.css';
import './styles/tables.css';
import './styles/pages.css';
import './styles/responsive.css';
import './styles/pages-extra.css';
import './styles/flow.css';
import './styles/brand-mark.css';

const root = document.getElementById('root');
if (!root) throw new Error('找不到 #root 挂载点');

createRoot(root).render(
  <StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </StrictMode>,
);