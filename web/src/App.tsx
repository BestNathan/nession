import { useState } from 'react'
import './App.css'

function App() {
  const [count, setCount] = useState(0)

  return (
    <>
      <div className="app">
        <h1>Nession Web UI</h1>
        <div className="card">
          <p>
            Distributed tmux agent system - Web Interface
          </p>
          <p className="info">
            Terminal emulator and agent management interface coming soon...
          </p>
          <button onClick={() => setCount((count) => count + 1)}>
            count is {count}
          </button>
        </div>
      </div>
    </>
  )
}

export default App
