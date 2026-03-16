import { useEffect } from 'react'
import { Navigate } from 'react-router-dom'
import { usePublishDrawer } from '../store/publishDrawerStore'

export default function PublishRedirect() {
  const openDrawer = usePublishDrawer(s => s.openDrawer)
  useEffect(() => { openDrawer() }, [openDrawer])
  return <Navigate to="/articles" replace />
}
