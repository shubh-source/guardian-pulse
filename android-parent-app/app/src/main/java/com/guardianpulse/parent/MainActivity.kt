package com.guardianpulse.parent

import android.annotation.SuppressLint
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.view.View
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Button
import android.widget.EditText
import android.widget.ImageButton
import android.widget.LinearLayout
import android.widget.ProgressBar
import android.widget.TextView
import androidx.activity.OnBackPressedCallback
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.app.AppCompatActivity

class MainActivity : AppCompatActivity() {

    private lateinit var webView: WebView
    private lateinit var loadingBar: ProgressBar
    private lateinit var offlineOverlay: LinearLayout
    private lateinit var errorDetailText: TextView
    private lateinit var retryButton: Button
    private lateinit var changeUrlButton: Button
    private lateinit var serverSettingsBtn: ImageButton

    private val prefs by lazy {
        getSharedPreferences("guardian_pulse_parent", Context.MODE_PRIVATE)
    }

    private var serverUrl: String
        get() = prefs.getString("server_url", DEFAULT_SERVER_URL) ?: DEFAULT_SERVER_URL
        set(value) = prefs.edit().putString("server_url", value.trimEnd('/')).apply()

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)

        webView = findViewById(R.id.parentWebView)
        loadingBar = findViewById(R.id.loadingBar)
        offlineOverlay = findViewById(R.id.offlineOverlay)
        errorDetailText = findViewById(R.id.errorDetailText)
        retryButton = findViewById(R.id.retryButton)
        changeUrlButton = findViewById(R.id.changeUrlButton)
        serverSettingsBtn = findViewById(R.id.serverSettingsBtn)

        webView.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            databaseEnabled = true
            cacheMode = WebSettings.LOAD_DEFAULT
            setSupportMultipleWindows(false)
            useWideViewPort = true
            loadWithOverviewMode = true
        }

        webView.webChromeClient = object : WebChromeClient() {
            override fun onProgressChanged(view: WebView?, newProgress: Int) {
                loadingBar.progress = newProgress
                loadingBar.visibility = if (newProgress in 1..99) View.VISIBLE else View.GONE
            }
        }

        webView.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView?, request: WebResourceRequest?): Boolean {
                val uri = request?.url ?: return false
                val configuredHost = Uri.parse(serverUrl).host
                if (uri.host != null && uri.host == configuredHost) {
                    return false
                }
                // External links (such as "Google Maps" from Stay Spots) open in native apps
                startActivity(Intent(Intent.ACTION_VIEW, uri))
                return true
            }

            override fun onPageFinished(view: WebView?, url: String?) {
                super.onPageFinished(view, url)
                if (offlineOverlay.visibility == View.VISIBLE && view?.title?.isNotBlank() == true) {
                    offlineOverlay.visibility = View.GONE
                }
            }

            override fun onReceivedError(
                view: WebView?,
                request: WebResourceRequest?,
                error: WebResourceError?
            ) {
                if (request?.isForMainFrame == true) {
                    offlineOverlay.visibility = View.VISIBLE
                    errorDetailText.text =
                        "Could not reach $serverUrl (${error?.description ?: "Network error"})."
                }
            }
        }

        retryButton.setOnClickListener { loadParentConsole() }
        changeUrlButton.setOnClickListener { promptServerUrl() }
        serverSettingsBtn.setOnClickListener { promptServerUrl() }

        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                if (webView.canGoBack()) {
                    webView.goBack()
                } else {
                    finish()
                }
            }
        })

        loadParentConsole()
    }

    private fun loadParentConsole() {
        offlineOverlay.visibility = View.GONE
        webView.loadUrl(serverUrl)
    }

    private fun promptServerUrl() {
        val input = EditText(this).apply {
            setText(serverUrl)
            hint = DEFAULT_SERVER_URL
            setSingleLine(true)
        }
        AlertDialog.Builder(this)
            .setTitle("Parent Server URL")
            .setMessage("Enter your deployed GuardianPulse Parent server URL:")
            .setView(input)
            .setPositiveButton("Save & Reload") { _, _ ->
                val entered = input.text.toString().trim().trimEnd('/')
                if (entered.startsWith("http://") || entered.startsWith("https://")) {
                    serverUrl = entered
                    loadParentConsole()
                }
            }
            .setNegativeButton("Cancel", null)
            .show()
    }

    companion object {
        private const val DEFAULT_SERVER_URL = "https://guardian-pulse.onrender.com"
    }
}
