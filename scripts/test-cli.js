const { app } = require('electron')

app.whenReady().then(async () => {
  try {
    const action = process.argv[2]
    console.log('[Test Runner] Running action:', action)
  } catch (err) {
    console.error(err)
  }
  app.quit()
})
