// React entry point — mounts the App into the #root DOM element.
import React from 'react';
import ReactDOM from 'react-dom/client';
import { App } from './App';
import { injectGlobalStyles } from './styles';

// Inject the god-view's global stylesheet (body margin/padding reset, dark
// color scheme, scrollbar styling) into the document head before mounting
// React. Idempotent — safe under HMR.
injectGlobalStyles();

// Locate the root DOM node and create a React 18 root
const root = ReactDOM.createRoot(document.getElementById('root')!);

// Render the App wrapped in StrictMode for development warnings
root.render(
    <React.StrictMode>
        <App />
    </React.StrictMode>,
);
