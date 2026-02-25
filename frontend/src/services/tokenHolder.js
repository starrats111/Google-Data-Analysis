/**
 * 内存中的 Access Token 持有器（SEC-7）
 * 用于打破 authStore <-> api 的循环依赖
 */
let _token = null

export const setToken = (token) => { _token = token }
export const getToken = () => _token
export const clearToken = () => { _token = null }
