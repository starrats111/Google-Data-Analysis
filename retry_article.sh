#!/bin/bash
TOKEN="eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ1c2VySWQiOiIyIiwidXNlcm5hbWUiOiJ3ajAxIiwicm9sZSI6InVzZXIiLCJpYXQiOjE3NzQ5MjgxMDMsImV4cCI6MTc3NDkzMTcwM30.jhhQV72R7gjXDSeSls-q2hEagbNIuBw8oE-_enkeIk8"
curl -s -X PATCH http://localhost:20050/api/user/articles -H "Content-Type: application/json" -H "Cookie: user_token=$TOKEN" -d '{"id":"572"}'
echo ""
