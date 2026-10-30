-- UPDATE version=version+1 also requires SELECT on this one counter column.
GRANT SELECT(version) ON users TO libetario_auth;
